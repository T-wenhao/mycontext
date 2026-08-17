"""Unit tests for POST /ingest/restore.

Directly awaits the endpoint coroutine with a monkeypatched module-level
`state`, plus a custom `_bootstrap_stores` that reopens the real test stores at
the test data dir (the real bootstrap reads process-level path constants).

Covers:
- backup → mutate → restore → reopen: counts return to the snapshot; ready is
  True and store is not None afterward; extraction_cache.db bytes unchanged.
- Missing required element → 400 raised *before* quiesce (original handles and
  counts untouched).
- A copy failure → move-aside rollback restores originals AND still reopens ready.
- An active ingest task → 409.
- not ready → 503; non-absolute src → 400.

Fake values only (AGENTS.md §1). Uses real SQLite + zvec stores.
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


def _open_stores(data_dir: Path, state: kl_server.ServerState) -> None:
    """打开 data_dir 下的 SQLite + zvec 主向量库并挂到 state。"""
    from kl_graph.storage.zvec_vector_store import ZvecVectorStore

    store = SQLiteStore(data_dir / "knowledge.db")
    state.store = store
    state.sqlite_conn = store.conn
    state.qdrant_main = ZvecVectorStore(
        data_dir / "zvec_data", embedding_dim=4, collections=("chunks",)
    )
    state.qdrant_communities = None


def _seed_entity(state: kl_server.ServerState, ent_id: str, name: str) -> None:
    from kl_graph.models.types import Entity, EntityType

    state.store.upsert_entities(
        [Entity(id=ent_id, name=name, entity_type=EntityType.PERSON)]
    )


def _seed_vector(state: kl_server.ServerState, cid: str) -> None:
    from kl_graph.storage.vector_store import VectorPoint

    state.qdrant_main.upsert(
        "chunks",
        [
            VectorPoint(
                id=cid, vector=[0.1, 0.2, 0.3, 0.4], payload={"chunk_id": cid}
            )
        ],
    )


def _install_test_bootstrap(monkeypatch, data_dir: Path) -> None:
    """把 _bootstrap_stores 换成「从 data_dir 重开测试栈」，避开读进程级常量。"""

    def _fake_bootstrap() -> None:
        _open_stores(data_dir, kl_server.state)

    monkeypatch.setattr(kl_server, "_bootstrap_stores", _fake_bootstrap)


def _force_sqlite_backend(monkeypatch) -> None:
    """把图后端标为非 ladybug，使 SQLite+zvec 夹具的必需元素只需 knowledge.db+向量目录。"""
    monkeypatch.setattr(kl_server.cfg.storage.graph, "backend", "sqlite")


# ─── Full round-trip ─────────────────────────────────────────────────────────


@skip_no_zvec
def test_restore_roundtrip_counts_return_to_snapshot(
    tmp_path: Path, monkeypatch
) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    state = kl_server.ServerState()
    state.ready = True
    state.startup_time = 0
    monkeypatch.setattr(kl_server, "state", state)
    _force_sqlite_backend(monkeypatch)
    _install_test_bootstrap(monkeypatch, data_dir)

    _open_stores(data_dir, state)
    _seed_entity(state, "FAKEENT0001", "张三")
    _seed_vector(state, "FAKECHUNK0001")

    # 派生缓存：恢复不应改动它。
    cache = data_dir / "extraction_cache.db"
    cache.write_bytes(b"FAKECACHE_SENTINEL_0001")

    # 1) 备份到 snap。
    snap = tmp_path / "snap"
    resp_b = asyncio.run(
        kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(snap)))
    )
    assert "knowledge.db" in {c.name for c in resp_b.copied}

    # 2) 备份后写入更多数据（计数变 2）。
    _seed_entity(state, "FAKEENT0002", "Alice")
    _seed_vector(state, "FAKECHUNK0002")
    assert state.store.count_entities() == 2
    assert state.qdrant_main.count("chunks") == 2
    # 改动缓存字节，证明恢复确实不碰它（应保持被改后的值，因为 restore 从不写它）。
    cache.write_bytes(b"FAKECACHE_MUTATED_0002")

    # 3) 恢复。
    resp_r = asyncio.run(
        kl_server.ingest_restore(kl_server.RestoreRequest(src_dir=str(snap)))
    )

    assert resp_r.restored is True
    assert resp_r.reopened is True
    assert state.ready is True
    assert state.store is not None
    assert "knowledge.db" in resp_r.restored_items
    assert "zvec_data" in resp_r.restored_items
    assert resp_r.skipped == ["extraction_cache.db"]

    # 计数回到快照时的 1。
    assert state.store.count_entities() == 1
    assert state.qdrant_main.count("chunks") == 1

    # 缓存未被恢复触碰：保持步骤 2 改动后的值（结构性排除）。
    assert cache.read_bytes() == b"FAKECACHE_MUTATED_0002"

    state.store.close()
    state.qdrant_main.close()


# ─── Missing required element → 400 before quiesce ───────────────────────────


@skip_no_zvec
def test_restore_missing_required_400_before_quiesce(
    tmp_path: Path, monkeypatch
) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    state = kl_server.ServerState()
    state.ready = True
    monkeypatch.setattr(kl_server, "state", state)
    _force_sqlite_backend(monkeypatch)

    _open_stores(data_dir, state)
    _seed_entity(state, "FAKEENT0001", "张三")
    live_store = state.store

    # 空的 src（缺 knowledge.db）→ 400，且不得 quiesce。
    empty_src = tmp_path / "empty"
    empty_src.mkdir()

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            kl_server.ingest_restore(kl_server.RestoreRequest(src_dir=str(empty_src)))
        )

    assert exc.value.status_code == 400
    # 句柄未被关闭：state.store 仍是同一实例、计数不变。
    assert state.store is live_store
    assert state.store.count_entities() == 1
    assert state.ready is True

    state.store.close()
    state.qdrant_main.close()


# ─── Copy failure → rollback + still reopen ──────────────────────────────────


@skip_no_zvec
def test_restore_copy_failure_rolls_back_and_reopens(
    tmp_path: Path, monkeypatch
) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    state = kl_server.ServerState()
    state.ready = True
    state.startup_time = 0
    monkeypatch.setattr(kl_server, "state", state)
    _force_sqlite_backend(monkeypatch)
    _install_test_bootstrap(monkeypatch, data_dir)

    _open_stores(data_dir, state)
    _seed_entity(state, "FAKEENT0001", "张三")
    _seed_vector(state, "FAKECHUNK0001")

    snap = tmp_path / "snap"
    asyncio.run(kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(snap))))

    # 让恢复期的拷贝必然失败 → 触发 move-aside 回滚路径。
    from kl_graph.storage import snapshot as _snap

    def _boom(_src, _dst):
        raise OSError("simulated restore copy failure")

    monkeypatch.setattr(_snap, "copy_path", _boom)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            kl_server.ingest_restore(kl_server.RestoreRequest(src_dir=str(snap)))
        )

    assert exc.value.status_code == 500
    # 回滚后仍重开：ready、store 可用，且原数据（计数 1）完好。
    assert state.ready is True
    assert state.store is not None
    assert state.store.count_entities() == 1
    assert state.qdrant_main.count("chunks") == 1
    # 原始文件已从 .restore-old-* 改回，data_dir 里没有残留的 move-aside 副本。
    leftovers = [p.name for p in data_dir.iterdir() if ".restore-old-" in p.name]
    assert leftovers == []

    state.store.close()
    state.qdrant_main.close()


# ─── Bootstrap failure after file-swap → rollback to old data (P1 #60) ───────


@skip_no_zvec
def test_restore_bootstrap_failure_rolls_back_to_old_data(
    tmp_path: Path, monkeypatch
) -> None:
    """文件已换好、但重开（_bootstrap_stores）失败：必须回滚到原数据并重开 ready。

    这是 #60 的核心：旧的实现会在 bootstrap 之前删掉 .restore-old-*，一旦快照损坏
    导致 bootstrap 失败，原数据已丢、服务卡死。现在 bootstrap 成功前不删 move-aside。
    """
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    state = kl_server.ServerState()
    state.ready = True
    state.startup_time = 0
    monkeypatch.setattr(kl_server, "state", state)
    _force_sqlite_backend(monkeypatch)

    _open_stores(data_dir, state)
    _seed_entity(state, "FAKEENT0001", "张三")  # 原数据计数 1
    _seed_vector(state, "FAKECHUNK0001")

    snap = tmp_path / "snap"
    asyncio.run(kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(snap))))

    # bootstrap 第一次调用（换文件后重开新数据）抛错；回滚里的第二次调用要成功。
    real_bootstrap = _open_stores
    calls = {"n": 0}

    def _bootstrap_first_fails() -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated corrupt-snapshot open failure")
        real_bootstrap(data_dir, kl_server.state)

    monkeypatch.setattr(kl_server, "_bootstrap_stores", _bootstrap_first_fails)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            kl_server.ingest_restore(kl_server.RestoreRequest(src_dir=str(snap)))
        )

    assert exc.value.status_code == 500
    # 回滚后：服务在**原数据**上重开，ready、计数完好、无 move-aside 残留、屏障已清。
    assert state.ready is True
    assert state.store is not None
    assert state.store.count_entities() == 1
    assert state.qdrant_main.count("chunks") == 1
    leftovers = [p.name for p in data_dir.iterdir() if ".restore-old-" in p.name]
    assert leftovers == []
    assert state.backup_active is False

    state.store.close()
    state.qdrant_main.close()


# ─── Barrier is mutually exclusive (P1 #61) ──────────────────────────────────


def test_restore_rejected_when_barrier_already_held(monkeypatch) -> None:
    """已有备份/恢复在进行时，restore 必须 409，且不 quiesce、不清别人的屏障。"""
    state = kl_server.ServerState()
    state.ready = True
    state.backup_active = True
    monkeypatch.setattr(kl_server, "state", state)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            kl_server.ingest_restore(kl_server.RestoreRequest(src_dir="/tmp/x"))
        )
    assert exc.value.status_code == 409
    assert state.backup_active is True


# ─── Guards ──────────────────────────────────────────────────────────────────


def test_restore_not_ready_503(monkeypatch) -> None:
    state = kl_server.ServerState()
    state.ready = False
    monkeypatch.setattr(kl_server, "state", state)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            kl_server.ingest_restore(kl_server.RestoreRequest(src_dir="/tmp/x"))
        )
    assert exc.value.status_code == 503


def test_restore_relative_src_400(tmp_path: Path, monkeypatch) -> None:
    state = kl_server.ServerState()
    state.ready = True
    monkeypatch.setattr(kl_server, "state", state)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            kl_server.ingest_restore(kl_server.RestoreRequest(src_dir="relative/x"))
        )
    assert exc.value.status_code == 400


def test_restore_active_ingest_409(monkeypatch) -> None:
    state = kl_server.ServerState()
    state.ready = True

    loop = asyncio.new_event_loop()

    async def _forever():
        await asyncio.sleep(9999)

    task = loop.create_task(_forever())
    state.ingest_task = task
    monkeypatch.setattr(kl_server, "state", state)

    async def _run():
        return await kl_server.ingest_restore(
            kl_server.RestoreRequest(src_dir="/tmp/x")
        )

    with pytest.raises(HTTPException) as exc:
        loop.run_until_complete(_run())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        loop.run_until_complete(task)
    loop.close()
    assert exc.value.status_code == 409


# ─── Remote qdrant: vector dir NOT required (P2 #63) ─────────────────────────


@skip_no_zvec
def test_restore_remote_qdrant_does_not_require_vector_dir(
    tmp_path: Path, monkeypatch
) -> None:
    """远端向量后端（snapshot_paths()==[]）时，缺向量目录不应导致 400。

    构造：主向量库是一个 snapshot_paths() 返回 [] 的桩（模拟远端 qdrant）。src 只含
    knowledge.db（无向量目录）。恢复应越过必需元素校验并成功重开。
    """
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    state = kl_server.ServerState()
    state.ready = True
    state.startup_time = 0
    monkeypatch.setattr(kl_server, "state", state)
    _force_sqlite_backend(monkeypatch)

    class _RemoteVecStub:
        """只暴露 restore 路径会用到的接口：snapshot_paths()==[]（无本地文件）。"""

        def checkpoint(self):
            pass

        def snapshot_paths(self):
            return []

        def close(self):
            pass

    # 真 SQLite + 远端向量桩。
    store = SQLiteStore(data_dir / "knowledge.db")
    state.store = store
    state.sqlite_conn = store.conn
    state.qdrant_main = _RemoteVecStub()
    state.qdrant_communities = None
    _seed_entity(state, "FAKEENT0001", "张三")

    # bootstrap 换成「重开 SQLite + 保留远端桩」。
    def _fake_bootstrap() -> None:
        s = SQLiteStore(data_dir / "knowledge.db")
        kl_server.state.store = s
        kl_server.state.sqlite_conn = s.conn
        kl_server.state.qdrant_main = _RemoteVecStub()
        kl_server.state.qdrant_communities = None

    monkeypatch.setattr(kl_server, "_bootstrap_stores", _fake_bootstrap)

    # 备份：远端后端只产出 knowledge.db（无向量目录）。
    snap = tmp_path / "snap"
    resp_b = asyncio.run(
        kl_server.ingest_backup(kl_server.BackupRequest(dest_dir=str(snap)))
    )
    names = {c.name for c in resp_b.copied}
    assert "knowledge.db" in names
    assert "zvec_data" not in names  # 远端桩无本地向量目录

    # 恢复：src 缺向量目录也**不应** 400——远端后端不要求它。
    resp_r = asyncio.run(
        kl_server.ingest_restore(kl_server.RestoreRequest(src_dir=str(snap)))
    )
    assert resp_r.restored is True
    assert state.ready is True
    assert state.store is not None
    assert state.store.count_entities() == 1
    assert state.backup_active is False

    state.store.close()
