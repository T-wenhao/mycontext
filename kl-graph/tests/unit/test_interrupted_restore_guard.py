"""Unit tests for the startup interrupted-restore guard.

背景：/ingest/restore 用 move-aside 保留原数据（改名为 <name>.restore-old-<ts>），成功重开
后才删。若 restore 被 SIGKILL 中途杀死，DATA_DIR 会留下 *.restore-old-* 副本，而目标
knowledge.db 可能缺失/空/破损。启动时 sqlite3.connect 会**自动新建空库**，从而静默在空数据上
起服务（假装数据丢了）。本模块验证启动兜底 _guard_interrupted_restore：

- 目标库不可用 + 存在 aside → 抛 InterruptedRestoreError（拒绝静默空库启动）。
- 目标库完好 + 残留 aside → 只告警、放行（restore 成功、只是清理没跑完）。
- 无 aside → 放行（正常启动）。
- _knowledge_db_is_healthy 对缺失/空/破损/真实库的判定。

全部假值（AGENTS.md §1）：用真实 SQLite 文件，无任何真人姓名/ID/路径。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import kl_server


def _make_real_knowledge_db(path: Path) -> None:
    """造一份「真实」库：含核心 chunks 表（区别于自动新建的空库）。"""
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE chunks (id TEXT PRIMARY KEY, content TEXT)")
        conn.execute("INSERT INTO chunks (id, content) VALUES ('FAKECHUNK0001', 'x')")
        conn.commit()
    finally:
        conn.close()


def _make_empty_db(path: Path) -> None:
    """造一份自动新建式空库：能过 quick_check，但没有业务表。"""
    conn = sqlite3.connect(str(path))
    conn.close()


# ─── _knowledge_db_is_healthy ────────────────────────────────────────────────


def test_healthy_false_when_missing(tmp_path: Path) -> None:
    assert kl_server._knowledge_db_is_healthy(tmp_path / "knowledge.db") is False


def test_healthy_false_when_empty(tmp_path: Path) -> None:
    db = tmp_path / "knowledge.db"
    _make_empty_db(db)
    # 空库无 chunks 表 → 判为不可用。
    assert kl_server._knowledge_db_is_healthy(db) is False


def test_healthy_false_when_corrupt(tmp_path: Path) -> None:
    db = tmp_path / "knowledge.db"
    # 半拷入的破损文件：写入非 SQLite 头字节。
    db.write_bytes(b"FAKE_PARTIAL_COPY_NOT_A_DB_0001")
    assert kl_server._knowledge_db_is_healthy(db) is False


def test_healthy_true_for_real_db(tmp_path: Path) -> None:
    db = tmp_path / "knowledge.db"
    _make_real_knowledge_db(db)
    assert kl_server._knowledge_db_is_healthy(db) is True


def test_healthy_ro_open_does_not_create_file(tmp_path: Path) -> None:
    """只读探测绝不能像 sqlite3.connect 那样把缺失文件建出来。"""
    db = tmp_path / "knowledge.db"
    assert kl_server._knowledge_db_is_healthy(db) is False
    assert not db.exists()


# ─── _guard_interrupted_restore ──────────────────────────────────────────────


def _point_module_at(monkeypatch, data_dir: Path) -> None:
    monkeypatch.setattr(kl_server, "DATA_DIR", data_dir)
    monkeypatch.setattr(kl_server, "SQLITE_PATH", data_dir / "knowledge.db")


def test_guard_no_aside_passes(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _point_module_at(monkeypatch, data_dir)
    # 无 aside、无库都行：无中断标记就直接放行（启动后建栈会自建 schema）。
    kl_server._guard_interrupted_restore()  # 不抛即通过


def test_guard_refuses_when_target_broken_and_aside_present(
    tmp_path: Path, monkeypatch
) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _point_module_at(monkeypatch, data_dir)

    # 危险态：目标库缺失（restore 半换态被杀），且原数据仍在 aside 副本里。
    (data_dir / "knowledge.db.restore-old-1700000000").write_bytes(
        b"FAKE_ORIGINAL_GOOD_DB_BYTES_0001"
    )

    with pytest.raises(kl_server.InterruptedRestoreError) as exc:
        kl_server._guard_interrupted_restore()
    msg = str(exc.value)
    # 恢复指引必须提到 aside 副本可无损恢复、且别删它。
    assert "restore-old" in msg
    assert "Refusing to start" in msg


def test_guard_refuses_when_target_corrupt_and_aside_present(
    tmp_path: Path, monkeypatch
) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _point_module_at(monkeypatch, data_dir)

    # 目标库是半拷入的破损文件（size>0 但非合法 DB）→ 仍属危险态。
    (data_dir / "knowledge.db").write_bytes(b"FAKE_HALF_COPIED_0001")
    (data_dir / "zvec_data.restore-old-1700000000").mkdir()

    with pytest.raises(kl_server.InterruptedRestoreError):
        kl_server._guard_interrupted_restore()


def test_guard_allows_when_target_healthy_despite_leftover_aside(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    """restore 成功、只是尽力清理没删干净：目标库完好则保留、只告警、放行。"""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _point_module_at(monkeypatch, data_dir)

    _make_real_knowledge_db(data_dir / "knowledge.db")
    stale = data_dir / "knowledge.db.restore-old-1699999999"
    stale.write_bytes(b"FAKE_STALE_ASIDE_0001")

    import logging

    with caplog.at_level(logging.WARNING, logger="kl-server"):
        kl_server._guard_interrupted_restore()  # 不抛

    # 不动磁盘：残留 aside 仍在（交由运维清）。
    assert stale.exists()
    assert any("healthy" in r.message for r in caplog.records)
