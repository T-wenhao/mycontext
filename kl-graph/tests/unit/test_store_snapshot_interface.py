"""Unit tests for the store snapshot interface: checkpoint() + snapshot_paths().

Verifies that each store can be checkpointed, its snapshot_paths() copied to a
fresh location via snapshot.copy_path, and reopened there with identical counts.
This is the load-bearing contract behind /ingest/backup + /ingest/restore.

- SQLite: checkpoint truncates WAL; snapshot_paths = [db, -wal, -shm]; round-trip.
- Ladybug: checkpoint drains graph .wal; snapshot_paths = sqlite set + graph pair;
  round-trip (skips if ladybug not installed).
- Zvec: checkpoint flushes each collection; snapshot_paths = [data_dir];
  round-trip (skips if zvec not installed).
- Qdrant remote returns [] from snapshot_paths (no local files).

All fixtures use fake values (AGENTS.md §1) under tmp_path.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kl_graph.storage import snapshot
from kl_graph.storage.sqlite_store import SQLiteStore

try:
    import ladybug  # noqa: F401

    has_ladybug = True
except ImportError:
    has_ladybug = False

try:
    import zvec  # noqa: F401

    has_zvec = True
except ImportError:
    has_zvec = False

skip_no_ladybug = pytest.mark.skipif(not has_ladybug, reason="ladybug not installed")
skip_no_zvec = pytest.mark.skipif(not has_zvec, reason="zvec not installed")


def _copy_snapshot(paths: list[Path], src_root: Path, dst_root: Path) -> None:
    """把一组 snapshot_paths 按 basename 拷到 dst_root（存在的才拷）。"""
    for p in paths:
        p = Path(p)
        if p.exists():
            snapshot.copy_path(p, dst_root / p.name)


# ─── SQLite ──────────────────────────────────────────────────────────────────


def test_sqlite_snapshot_paths_shape(tmp_path: Path) -> None:
    store = SQLiteStore(tmp_path / "knowledge.db")
    paths = store.snapshot_paths()
    names = [Path(p).name for p in paths]
    assert names == ["knowledge.db", "knowledge.db-wal", "knowledge.db-shm"]
    store.close()


def test_sqlite_checkpoint_then_restore_roundtrip(tmp_path: Path) -> None:
    """写入 → checkpoint → 拷贝 snapshot_paths → 在新目录重开 → 计数一致。"""
    from kl_graph.models.types import Entity, EntityType

    src_db = tmp_path / "src" / "knowledge.db"
    src_db.parent.mkdir(parents=True)
    store = SQLiteStore(src_db)
    store.upsert_entities(
        [Entity(id="FAKEENT0001", name="张三", entity_type=EntityType.PERSON)]
    )

    store.checkpoint()  # PRAGMA wal_checkpoint(TRUNCATE)

    dst = tmp_path / "snap"
    dst.mkdir()
    _copy_snapshot(store.snapshot_paths(), src_db.parent, dst)
    before = store.count_entities()
    store.close()

    # 重开拷贝副本，计数必须一致。
    reopened = SQLiteStore(dst / "knowledge.db")
    assert reopened.count_entities() == before == 1
    reopened.close()


# ─── Ladybug ─────────────────────────────────────────────────────────────────


@skip_no_ladybug
def test_ladybug_snapshot_paths_include_graph_pair(tmp_path: Path) -> None:
    from kl_graph.storage.ladybug_store import LadybugStore

    store = LadybugStore(tmp_path / "knowledge.db", str(tmp_path / "graph.ladybug"))
    names = {Path(p).name for p in store.snapshot_paths()}
    assert {"knowledge.db", "graph.ladybug"} <= names
    store.close()


@skip_no_ladybug
def test_ladybug_checkpoint_then_restore_roundtrip(tmp_path: Path) -> None:
    from kl_graph.models.types import Entity, EntityType
    from kl_graph.storage.ladybug_store import LadybugStore

    src_root = tmp_path / "src"
    src_root.mkdir()
    store = LadybugStore(src_root / "knowledge.db", str(src_root / "graph.ladybug"))
    store.upsert_entities(
        [Entity(id="FAKEENT0001", name="Alice", entity_type=EntityType.PERSON)]
    )

    store.checkpoint()

    dst = tmp_path / "snap"
    dst.mkdir()
    _copy_snapshot(store.snapshot_paths(), src_root, dst)
    before = store.count_entities()
    store.close()

    reopened = LadybugStore(dst / "knowledge.db", str(dst / "graph.ladybug"))
    assert reopened.count_entities() == before == 1
    reopened.close()


# ─── Zvec ────────────────────────────────────────────────────────────────────


@skip_no_zvec
def test_zvec_snapshot_paths_is_data_dir(tmp_path: Path) -> None:
    from kl_graph.storage.zvec_vector_store import ZvecVectorStore

    data_dir = tmp_path / "zvec_data"
    store = ZvecVectorStore(data_dir, embedding_dim=4, collections=("chunks",))
    paths = store.snapshot_paths()
    assert [Path(p) for p in paths] == [data_dir]
    store.close()


@skip_no_zvec
def test_zvec_checkpoint_then_restore_roundtrip(tmp_path: Path) -> None:
    from kl_graph.storage.vector_store import VectorPoint
    from kl_graph.storage.zvec_vector_store import ZvecVectorStore

    src_dir = tmp_path / "src" / "zvec_data"
    store = ZvecVectorStore(src_dir, embedding_dim=4, collections=("chunks",))
    store.upsert(
        "chunks",
        [
            VectorPoint(
                id="FAKECHUNK0001",
                vector=[0.1, 0.2, 0.3, 0.4],
                payload={"chunk_id": "FAKECHUNK0001", "content": "张三 said hi"},
            )
        ],
    )
    store.checkpoint()
    before = store.count("chunks")
    assert before == 1

    dst_parent = tmp_path / "snap"
    dst_parent.mkdir()
    # snapshot_paths 返回整个 data_dir；拷到 snap/zvec_data。
    _copy_snapshot(store.snapshot_paths(), src_dir.parent, dst_parent)
    store.close()

    reopened = ZvecVectorStore(
        dst_parent / "zvec_data", embedding_dim=4, collections=("chunks",)
    )
    assert reopened.count("chunks") == before
    reopened.close()


# ─── Qdrant remote ───────────────────────────────────────────────────────────


def test_qdrant_remote_snapshot_paths_empty() -> None:
    """远端 Qdrant（配了 host）无本地文件，snapshot_paths 返回 []。"""
    from kl_graph.storage.qdrant_vector_store import QdrantVectorStore

    # 构造一个 host 模式实例但不真正连接：直接在类上验证分支逻辑。
    # __init__ 会尝试建 QdrantStore，故用一个轻量 stub 绕过实际连接。
    inst = QdrantVectorStore.__new__(QdrantVectorStore)
    inst.path = "/tmp/should-be-ignored"
    inst._host = "remote.example.invalid"
    assert inst.snapshot_paths() == []

    inst2 = QdrantVectorStore.__new__(QdrantVectorStore)
    inst2.path = "/tmp/local-qdrant"
    inst2._host = ""
    assert [Path(p).name for p in inst2.snapshot_paths()] == ["local-qdrant"]
