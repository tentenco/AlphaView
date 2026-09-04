import subprocess
import sys
import threading
from unittest.mock import patch

import pytest

pytest.importorskip("fcntl")
from alphaview.panel.locking import WorkspaceLock


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    path = tmp_path / "workspace" / "test.db"
    monkeypatch.setenv("PANEL_DB_PATH", str(path))
    return path


def subprocess_probe():
    return subprocess.run([
        sys.executable, "-c",
        "from alphaview.panel.locking import WorkspaceLock; "
        "lock=WorkspaceLock(); acquired=lock.acquire(False); print(acquired); "
        "lock.release() if acquired else None",
    ], text=True, capture_output=True, timeout=10, check=True).stdout.strip()


def test_instances_contend_and_nonreentrant_release_recovers(workspace):
    first, second = WorkspaceLock(), WorkspaceLock()
    assert first.acquire(False)
    assert first.locked() and second.locked()
    assert not first.acquire(False)
    assert not second.acquire(False)
    inode = first.lock_path().stat().st_ino
    first.release()
    assert not first.locked()
    assert second.acquire(False)
    assert second.lock_path().stat().st_ino == inode
    second.release()
    assert second.lock_path().exists()


def test_subprocess_cannot_enter_until_writer_releases(workspace):
    with WorkspaceLock():
        assert subprocess_probe() == "False"
    assert subprocess_probe() == "True"


def test_kernel_releases_after_process_death(workspace):
    process = subprocess.Popen([
        sys.executable, "-c",
        "import sys; from alphaview.panel.locking import WorkspaceLock; "
        "lock=WorkspaceLock(); lock.acquire(); print('ready', flush=True); sys.stdin.read()",
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        # communicate(timeout) is reserved for teardown; this short startup uses
        # an OS-level readiness check so a broken child cannot hang the suite.
        import select
        assert select.select([process.stdout], [], [], 10)[0]
        assert process.stdout.readline().strip() == "ready"
        lock = WorkspaceLock()
        assert not lock.acquire(False)
        process.kill()
        process.wait(timeout=10)
        assert lock.acquire(False)
        lock.release()
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)


def test_main_thread_acquire_worker_thread_release(workspace):
    lock = WorkspaceLock()
    assert lock.acquire(False)
    errors = []

    def release():
        try:
            lock.release()
        except Exception as exc:
            errors.append(exc)

    worker = threading.Thread(target=release)
    worker.start()
    worker.join(timeout=5)
    assert not worker.is_alive()
    assert not errors
    assert not lock.locked()


def test_distinct_databases_are_independent_and_path_is_dynamic(workspace, tmp_path, monkeypatch):
    first, second = WorkspaceLock(), WorkspaceLock()
    assert first.acquire(False)
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "other.db"))
    assert second.acquire(False)
    first.release()  # Release the actual held descriptor, not today's env path.
    assert not first.acquire(False)
    second.release()
    assert first.acquire(False)
    first.release()


def test_symlink_database_paths_share_lock(workspace, tmp_path, monkeypatch):
    workspace.parent.mkdir(parents=True)
    workspace.touch()
    alias = tmp_path / "alias.db"
    alias.symlink_to(workspace)
    with WorkspaceLock():
        monkeypatch.setenv("PANEL_DB_PATH", str(alias))
        assert not WorkspaceLock().acquire(False)


def test_release_without_acquisition_raises_and_context_releases_on_error(workspace):
    lock = WorkspaceLock()
    with pytest.raises(RuntimeError, match="unlocked"):
        lock.release()
    with pytest.raises(ValueError, match="body"):
        with lock:
            raise ValueError("body failed")
    assert not lock.locked()
    with pytest.raises(RuntimeError, match="unlocked"):
        lock.release()


def test_open_failure_does_not_poison_thread_gate(workspace):
    lock = WorkspaceLock()
    with patch("alphaview.panel.locking.os.open", side_effect=PermissionError("denied")):
        with pytest.raises(PermissionError):
            lock.acquire(False)
    assert lock.acquire(False)
    lock.release()


def test_blocking_acquire_waits_for_other_instance(workspace):
    first, second = WorkspaceLock(), WorkspaceLock()
    first.acquire()
    attempting, entered = threading.Event(), threading.Event()

    def acquire():
        attempting.set()
        with second:
            entered.set()

    worker = threading.Thread(target=acquire, daemon=True)
    worker.start()
    assert attempting.wait(timeout=5)
    assert not entered.wait(timeout=.05)
    first.release()
    assert entered.wait(timeout=5)
    worker.join(timeout=5)
    assert not worker.is_alive()
