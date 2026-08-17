"""Unit tests for POST /ingest/backup.

Directly awaits the endpoint coroutine with a monkeypatched module-level
`state` (mirrors test_recovery_info.py). Uses a real SQLite store + real zvec
main vector store so _do_backup exercises checkpoint() + snapshot_paths() +
copy_path end to end.

Covers:
- Happy path: copies knowledge.db + vector dir, excludes extraction_cache.db,
  returns a manifest; the cache is NOT present in dest.
- backup_active is cleared in `finally` on both success and failure.
- An active ingest task → 409.
- not ready → 503; non-absolute dest → 400; dest already populated → 400.
- Insufficient disk headroom → 500 and dest removed.

Fake values only (AGENTS.md §1).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

import kl_server
from kl_graph.storage.sqlite_store import SQLiteStore

try:
    import zvec  # noqa: F401

    has_zvec = True
except ImportError:
    has_zvec = False

skip_no_zvec = pytest.mark.skipif(not has_zvec, reason="zvec not installed")


def _build_state(data_dir: Path) -> kl_server.ServerState:
    """真实 SQLite + zvec 主向量库的最小 ServerState。"""
    from kl_graph.models.types import Entity, EntityType
    from kl_graph.storage.vector_store import VectorPoint
    from kl_graph.storage.zvec_vector_store import ZvecVectorStore

    data_dir.mkdir(parents=True, exist_ok=True)
    state = kl_server.ServerState()

    store = SQLiteStore(data_dir / "knowledge.db")
    store.upsert_entities(
        [Entity(id="FAKEENT0001", name="张三", entity_type=EntityType.PERSON)]
    )
    state.store = store
    state.sqlite_conn = store.conn

    vec = ZvecVectorStore(
        data_dir / "zvec_data", embedding_dim=4, collections=("chunks",)
    )
    vec.upsert(
        "chunks",
        [
            VectorPoint(
                id="FAKECHUNK0001",
                vector=[0.1, 0.2, 0.3, 0.4],
                payload={"chunk_id": "FAKECHUNK0001", "content": "Alice hi"},
            )
        ],
    )
    state.qdrant_main = vec

    # 派生缓存文件：必须被结构性排除，不进快照。
    (data_dir / "extraction_cache.db").write_bytes(b"FAKECACHE0001")

    state.ready = True
    state.startup_time = 0
    return state


def _close_state(state: kl_server.ServerState) -> None:
    if state.store is not None:
        state.store.close()
    if state.qdrant_main is not None:
        state.qdrant_main.close()


# ─── Happy path ──────────────────────────────────────────────────────────────


@skip_no_zvec
def test_backup_happy_path_excludes_cache(tmp_path: Path, monkeypatch) -> None:
    state = _build_state(tmp_path / "data")
    monkeypatch.setattr(kl_server, "state", state)

    dest = tmp_path / "snap"
    try:
        resp = asyncio.run(
            kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(dest)))
        )
    finally:
        _close_state(state)

    copied_names = {c.name for c in resp.copied}
    assert "knowledge.db" in copied_names
    assert "zvec_data" in copied_names
    # 结构性排除：cache 不在拷贝集，也不在 dest。
    assert "extraction_cache.db" not in copied_names
    assert not (dest / "extraction_cache.db").exists()
    assert resp.skipped == ["extraction_cache.db"]
    assert resp.bytes > 0
    # 屏障已在 finally 清除。
    assert state.backup_active is False
    # dest 自包含且可读回。
    assert (dest / "knowledge.db").exists()
    assert (dest / "zvec_data").is_dir()


# ─── backup_active cleared on failure ────────────────────────────────────────


@skip_no_zvec
def test_backup_active_cleared_on_failure(tmp_path: Path, monkeypatch) -> None:
    state = _build_state(tmp_path / "data")
    monkeypatch.setattr(kl_server, "state", state)

    def _boom(_dest):
        raise RuntimeError("simulated copy failure")

    monkeypatch.setattr(kl_server, "_do_backup", _boom)

    dest = tmp_path / "snap"
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(dest)))
            )
    finally:
        _close_state(state)

    assert exc.value.status_code == 500
    # 关键：即便失败，屏障也必须清除，否则后续 ingest 永久 409。
    assert state.backup_active is False


# ─── Guards ──────────────────────────────────────────────────────────────────


def test_backup_not_ready_503(tmp_path: Path, monkeypatch) -> None:
    state = kl_server.ServerState()
    state.ready = False
    monkeypatch.setattr(kl_server, "state", state)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            kl_server.ingest_backup(kl_server.BackupRequest(dest_dir="/tmp/x"))
        )
    assert exc.value.status_code == 503


def test_backup_relative_dest_400(tmp_path: Path, monkeypatch) -> None:
    state = kl_server.ServerState()
    state.ready = True
    monkeypatch.setattr(kl_server, "state", state)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            kl_server.ingest_backup(kl_server.BackupRequest(dest_dir="relative/path"))
        )
    assert exc.value.status_code == 400


def test_backup_active_ingest_409(tmp_path: Path, monkeypatch) -> None:
    state = kl_server.ServerState()
    state.ready = True

    loop = asyncio.new_event_loop()

    async def _forever():
        await asyncio.sleep(9999)

    task = loop.create_task(_forever())
    state.ingest_task = task
    monkeypatch.setattr(kl_server, "state", state)

    async def _run():
        return await kl_server.ingest_backup(
            kl_server.BackupRequest(dest_dir="/tmp/x")
        )

    with pytest.raises(HTTPException) as exc:
        loop.run_until_complete(_run())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        loop.run_until_complete(task)
    loop.close()
    assert exc.value.status_code == 409


@skip_no_zvec
def test_backup_dest_already_populated_400(tmp_path: Path, monkeypatch) -> None:
    state = _build_state(tmp_path / "data")
    monkeypatch.setattr(kl_server, "state", state)

    dest = tmp_path / "snap"
    dest.mkdir()
    # 预放一个与目标同名的元素 → 端点应拒绝，保持自包含目标干净。
    (dest / "knowledge.db").write_bytes(b"FAKEOLD0001")

    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(dest)))
            )
    finally:
        _close_state(state)

    assert exc.value.status_code == 400
    assert state.backup_active is False


@skip_no_zvec
def test_backup_insufficient_headroom_500_and_cleanup(
    tmp_path: Path, monkeypatch
) -> None:
    state = _build_state(tmp_path / "data")
    monkeypatch.setattr(kl_server, "state", state)

    # 让余量预检必失败：free_bytes 返回 0。
    from kl_graph.storage import snapshot as _snap

    monkeypatch.setattr(_snap, "free_bytes", lambda _p: 0)

    dest = tmp_path / "snap"
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(dest)))
            )
    finally:
        _close_state(state)

    assert exc.value.status_code == 500
    # 预检在拷贝之前失败，dest 里不应出现任何快照文件（无半成品）。
    if dest.exists():
        assert list(dest.iterdir()) == []
    assert state.backup_active is False


# ─── Copy failure must not delete unrelated caller files (P1 #62) ────────────


@skip_no_zvec
def test_backup_copy_failure_preserves_unrelated_dest_files(
    tmp_path: Path, monkeypatch
) -> None:
    """dest_dir 里调用方的无关文件，在拷贝中途失败时**不得**被删。"""
    state = _build_state(tmp_path / "data")
    monkeypatch.setattr(kl_server, "state", state)

    dest = tmp_path / "snap"
    dest.mkdir()
    # 调用方在 dest 里放了无关文件（与任何目标 basename 都不冲突）。
    keeper = dest / "caller-notes.txt"
    keeper.write_text("FAKE_CALLER_DATA_0001", encoding="utf-8")

    # 让第一个元素之后的拷贝失败：copy_path 第二次调用抛错。
    from kl_graph.storage import snapshot as _snap

    calls = {"n": 0}

    def _flaky_copy(src, dst):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise OSError("simulated mid-copy failure")
        # 造出半成品目标，验证它被清、而 keeper 不被清。
        Path(dst).write_bytes(b"FAKEPARTIAL0001")
        return 15

    monkeypatch.setattr(_snap, "copy_path", _flaky_copy)

    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(dest)))
            )
    finally:
        _close_state(state)

    assert exc.value.status_code == 500
    # 关键：调用方的无关文件必须原样保留，dest 目录本身也不能被 rmtree。
    assert keeper.exists()
    assert keeper.read_text(encoding="utf-8") == "FAKE_CALLER_DATA_0001"
    assert state.backup_active is False


# ─── Barrier is mutually exclusive (P1 #61) ──────────────────────────────────


@skip_no_zvec
def test_backup_rejected_when_barrier_already_held(
    tmp_path: Path, monkeypatch
) -> None:
    """已有备份/恢复在进行（backup_active=True）时，新备份必须 409 且不清屏障。"""
    state = _build_state(tmp_path / "data")
    state.backup_active = True  # 模拟另一个操作已持屏障
    monkeypatch.setattr(kl_server, "state", state)

    dest = tmp_path / "snap"
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(dest)))
            )
    finally:
        _close_state(state)

    assert exc.value.status_code == 409
    # 被拒的请求绝不能清掉别人持有的屏障。
    assert state.backup_active is True
