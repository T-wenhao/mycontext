"""快照拷贝助手：把存储文件/目录成组拷到目标位置。

纯文件系统操作，不含任何引擎知识（哪些路径要拷由各 store 的 ``snapshot_paths()``
决定）。核心诉求：

- **尽力 COW（reflink）**：同一文件系统内 reflink 近乎零成本且原子，拿不到就退回
  ``shutil`` 深拷贝。reflink 的支持性按「本次运行」缓存，避免在不支持的文件系统上
  每个文件都触发一次失败的 ``ioctl``。
- **逐元素 all-or-nothing**：拷贝单个元素（一个文件或一整棵目录树）出错时，先删掉
  半成品目标再把异常抛出去 —— 绝不留下「拷了一半」的目标让上层误以为成功
  （AGENTS.md §4：不静默降级）。
"""

from __future__ import annotations

import ctypes
import errno
import fcntl
import os
import shutil
import sys
from pathlib import Path

# Linux ioctl(FICLONE)：把 src 的整份 extent 以 COW 方式克隆到 dst。
# 常量对所有架构一致（_IOW('f', 9, int)）。
_FICLONE = 0x40049409

# reflink 支持性按进程缓存：None=未知，True/False=已探明。
# 只要在一个不支持的文件系统上失败过一次，就不再重复尝试 ioctl。
_reflink_supported: bool | None = None


def _reflink_file(src: Path, dst: Path) -> bool:
    """尝试对单个文件做 COW 克隆。

    成功返回 True；文件系统/平台不支持返回 False（上层回退到普通拷贝）。
    只有「不支持」类错误（EOPNOTSUPP/ENOTSUP/EXDEV/EINVAL/ENOSYS）算作 False；
    其余 OSError 继续上抛（那是真的 IO 故障，不能当作「不支持」吞掉）。
    """
    global _reflink_supported
    if _reflink_supported is False:
        return False

    unsupported = {
        errno.EOPNOTSUPP,
        errno.ENOTSUP,
        errno.EXDEV,
        errno.EINVAL,
        errno.ENOSYS,
    }
    try:
        if sys.platform == "darwin":
            # macOS：clonefile(2)。dst 必须不存在。
            libc = ctypes.CDLL("libSystem.dylib", use_errno=True)
            rc = libc.clonefile(
                os.fsencode(str(src)), os.fsencode(str(dst)), ctypes.c_uint32(0)
            )
            if rc == 0:
                _reflink_supported = True
                return True
            err = ctypes.get_errno()
            if err in unsupported:
                _reflink_supported = False
                return False
            raise OSError(err, os.strerror(err))
        # Linux：ioctl(FICLONE)。需要一个已存在（可写）的 dst fd。
        with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
            try:
                fcntl.ioctl(fdst.fileno(), _FICLONE, fsrc.fileno())
            except OSError:
                # ioctl 失败：dst 已被 open('wb') 建成空文件，先删掉再判定。
                fdst.close()
                dst.unlink(missing_ok=True)
                raise
        _reflink_supported = True
        return True
    except OSError as exc:
        if exc.errno in unsupported:
            _reflink_supported = False
            return False
        raise


def _copy_file(src: Path, dst: Path) -> int:
    """拷贝单个文件：先试 reflink，失败退回 ``shutil.copy2``（保留 mtime）。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not _reflink_file(src, dst):
        shutil.copy2(src, dst)
    return dst.stat().st_size


def _copy_tree(src: Path, dst: Path) -> int:
    """拷贝整棵目录树，每个内部文件仍尝试 reflink。返回总字节数。"""

    def _copy_fn(s: str, d: str) -> None:
        _copy_file(Path(s), Path(d))

    shutil.copytree(src, dst, copy_function=_copy_fn, dirs_exist_ok=False)
    return dir_size(dst)


def copy_path(src: Path, dst: Path) -> int:
    """把一个文件或目录树 ``src`` 拷到 ``dst``，返回拷贝的字节数。

    逐元素 all-or-nothing：任何失败都会先清掉半成品 ``dst`` 再把异常抛出去。
    """
    src = Path(src)
    dst = Path(dst)
    try:
        if src.is_dir():
            return _copy_tree(src, dst)
        return _copy_file(src, dst)
    except BaseException:
        # 清掉半成品目标（best-effort），不掩盖原始异常。
        try:
            if dst.is_dir():
                shutil.rmtree(dst, ignore_errors=True)
            else:
                dst.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def dir_size(path: Path) -> int:
    """递归统计文件或目录树占用的字节数（用于清单与磁盘余量预检）。"""
    path = Path(path)
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            fp = Path(root) / name
            try:
                total += fp.stat().st_size
            except OSError:
                # 拷贝期间无并发写者（屏障保证），此处仅防符号链接等边角。
                pass
    return total


def free_bytes(path: Path) -> int:
    """返回 ``path`` 所在文件系统的可用字节数。

    ``path`` 可以尚不存在 —— 逐级上溯到第一个存在的祖先目录再统计。
    """
    p = Path(path)
    while not p.exists():
        parent = p.parent
        if parent == p:
            break
        p = parent
    return shutil.disk_usage(p).free


__all__ = ["copy_path", "dir_size", "free_bytes"]
