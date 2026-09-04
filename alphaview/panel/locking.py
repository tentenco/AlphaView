"""Coordinate local workspace writers across API threads and CLI processes.

The empty lock file is deliberately persistent. Unlinking it could let a new
process lock a different inode while an existing writer still owns the old one.
Ownership lives in the kernel, not in the presence of the file or a saved PID.
This implementation targets macOS/Linux (fcntl.flock).
"""
import errno
import fcntl
import os
from pathlib import Path
import threading

from . import store


class WorkspaceLock:
    """A non-reentrant writer lock that may be released by another thread.

    The database path is resolved on each acquisition, so test/workspace changes
    do not leave a module-level instance permanently bound to its first database.
    ``locked()`` reports workspace contention, including another process; like
    threading.Lock.locked(), its answer is a snapshot, not a reservation.
    """

    def __init__(self):
        self._gate = threading.Lock()
        self._state = threading.Lock()
        self._fd = None

    @staticmethod
    def lock_path():
        database = store.db_path().expanduser().resolve()
        return Path(str(database) + ".lock")

    def acquire(self, blocking=True):
        if not self._gate.acquire(blocking=blocking):
            return False
        fd = None
        acquired = False
        try:
            path = self.lock_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
            os.set_inheritable(fd, False)
            operation = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
            while True:
                try:
                    fcntl.flock(fd, operation)
                    break
                except OSError as exc:
                    if exc.errno == errno.EINTR:
                        continue
                    if not blocking and exc.errno in (errno.EACCES, errno.EAGAIN):
                        return False
                    raise
            with self._state:
                self._fd = fd
            acquired = True
            return True
        finally:
            if not acquired:
                try:
                    if fd is not None:
                        os.close(fd)
                finally:
                    self._gate.release()

    def release(self):
        with self._state:
            if self._fd is None:
                raise RuntimeError("release unlocked workspace lock")
            fd, self._fd = self._fd, None
            try:
                # Closing the descriptor is sufficient to release the flock and
                # avoids keeping a lock alive if an explicit LOCK_UN fails.
                os.close(fd)
            finally:
                self._gate.release()

    def locked(self):
        if self._gate.locked():
            return True
        if not self.acquire(blocking=False):
            return True
        self.release()
        return False

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.release()
        return False
