"""Unit tests for kl_graph.storage.snapshot copy helpers.

Covers:
- File and directory-tree round-trip (content preserved, byte count returned).
- reflink fallback: when _reflink_file returns False and when it raises
  OSError(EOPNOTSUPP), copy_path still succeeds via shutil.
- All-or-nothing: a mid-copy failure removes the partial dst and re-raises.
- dir_size / free_bytes.

All fixtures use fake content only (AGENTS.md §1) and live under tmp_path.
"""

from __future__ import annotations

import errno
from pathlib import Path

import pytest

from kl_graph.storage import snapshot


# ─── File / tree round-trip ──────────────────────────────────────────────────


def test_copy_file_roundtrip(tmp_path: Path) -> None:
    src = tmp_path / "knowledge.db"
    src.write_text("hello 张三", encoding="utf-8")
    dst = tmp_path / "out" / "knowledge.db"

    n = snapshot.copy_path(src, dst)

    assert dst.read_text(encoding="utf-8") == "hello 张三"
    assert n == dst.stat().st_size
    assert n > 0


def test_copy_tree_roundtrip(tmp_path: Path) -> None:
    src = tmp_path / "zvec_data"
    (src / "chunks").mkdir(parents=True)
    (src / "chunks" / "data.bin").write_bytes(b"FAKEVEC0001")
    (src / "point_ids.sqlite3").write_bytes(b"FAKEMANIFEST0001")
    dst = tmp_path / "snap" / "zvec_data"

    n = snapshot.copy_path(src, dst)

    assert (dst / "chunks" / "data.bin").read_bytes() == b"FAKEVEC0001"
    assert (dst / "point_ids.sqlite3").read_bytes() == b"FAKEMANIFEST0001"
    assert n == snapshot.dir_size(dst)
    assert n == len(b"FAKEVEC0001") + len(b"FAKEMANIFEST0001")


# ─── reflink fallback ────────────────────────────────────────────────────────


def test_copy_file_falls_back_when_reflink_returns_false(
    tmp_path: Path, monkeypatch
) -> None:
    """reflink 不支持（返回 False）时仍能经 shutil 完整拷贝。"""
    monkeypatch.setattr(snapshot, "_reflink_file", lambda src, dst: False)

    src = tmp_path / "knowledge.db"
    src.write_text("Alice", encoding="utf-8")
    dst = tmp_path / "out.db"

    n = snapshot.copy_path(src, dst)

    assert dst.read_text(encoding="utf-8") == "Alice"
    assert n == dst.stat().st_size


def test_copy_file_falls_back_when_reflink_raises_eopnotsupp(
    tmp_path: Path, monkeypatch
) -> None:
    """真实 _reflink_file 在 EOPNOTSUPP 上应返回 False（内部吞掉），copy_path 成功。

    直接调用真实实现，模拟底层 ioctl/clonefile 抛 EOPNOTSUPP。
    """
    # 复位每运行缓存，避免其它测试污染。
    monkeypatch.setattr(snapshot, "_reflink_supported", None)

    def _boom(*_a, **_k):
        raise OSError(errno.EOPNOTSUPP, "not supported")

    # macOS 走 clonefile / Linux 走 open+ioctl；两条路径的底层都打桩成抛 EOPNOTSUPP。
    monkeypatch.setattr(snapshot.fcntl, "ioctl", _boom)
    monkeypatch.setattr(snapshot.ctypes, "CDLL", lambda *_a, **_k: _boom())

    src = tmp_path / "knowledge.db"
    src.write_text("A同学", encoding="utf-8")
    dst = tmp_path / "out.db"

    n = snapshot.copy_path(src, dst)

    assert dst.read_text(encoding="utf-8") == "A同学"
    assert n == dst.stat().st_size
    # 探明不支持后应缓存 False。
    assert snapshot._reflink_supported is False


# ─── All-or-nothing cleanup ──────────────────────────────────────────────────


def test_copy_tree_partial_failure_cleans_up(tmp_path: Path, monkeypatch) -> None:
    """目录树拷到一半失败 → 删掉半成品 dst，再抛原异常。"""
    monkeypatch.setattr(snapshot, "_reflink_file", lambda src, dst: False)

    src = tmp_path / "zvec_data"
    (src / "a").mkdir(parents=True)
    (src / "a" / "f1.bin").write_bytes(b"FAKE1")
    (src / "a" / "f2.bin").write_bytes(b"FAKE2")
    dst = tmp_path / "snap" / "zvec_data"

    calls = {"n": 0}
    real_copy2 = snapshot.shutil.copy2

    def _flaky_copy2(s, d, *a, **k):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise OSError(errno.EIO, "disk exploded")
        return real_copy2(s, d, *a, **k)

    monkeypatch.setattr(snapshot.shutil, "copy2", _flaky_copy2)

    with pytest.raises(OSError):
        snapshot.copy_path(src, dst)

    # 半成品目标必须已被清掉，不能留「拷了一半」的目录。
    assert not dst.exists()


def test_copy_file_failure_cleans_up_partial(tmp_path: Path, monkeypatch) -> None:
    """单文件拷贝失败也清掉半成品目标。"""
    monkeypatch.setattr(snapshot, "_reflink_file", lambda src, dst: False)

    def _boom(s, d, *a, **k):
        # 先造出一个空 dst 再失败，模拟半成品。
        Path(d).write_bytes(b"")
        raise OSError(errno.ENOSPC, "no space")

    monkeypatch.setattr(snapshot.shutil, "copy2", _boom)

    src = tmp_path / "knowledge.db"
    src.write_text("张三", encoding="utf-8")
    dst = tmp_path / "out.db"

    with pytest.raises(OSError):
        snapshot.copy_path(src, dst)

    assert not dst.exists()


# ─── dir_size / free_bytes ───────────────────────────────────────────────────


def test_dir_size_file_and_tree(tmp_path: Path) -> None:
    f = tmp_path / "f.bin"
    f.write_bytes(b"1234567890")
    assert snapshot.dir_size(f) == 10

    d = tmp_path / "d"
    (d / "sub").mkdir(parents=True)
    (d / "sub" / "a.bin").write_bytes(b"12345")
    (d / "b.bin").write_bytes(b"123")
    assert snapshot.dir_size(d) == 8


def test_free_bytes_walks_up_to_existing_ancestor(tmp_path: Path) -> None:
    """free_bytes 对尚不存在的路径也能返回正数（上溯到存在的祖先）。"""
    nonexistent = tmp_path / "does" / "not" / "exist" / "yet"
    free = snapshot.free_bytes(nonexistent)
    assert free > 0
