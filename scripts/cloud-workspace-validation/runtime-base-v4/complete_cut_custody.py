"""Dormant outside cut monitor. There is no installed support or CLI entry.

Only a qualified Host may launch this in an independent process/filesystem,
outside the tenant cgroup, holding original admission/peer authority. Freezer
state is not pending-I/O proof; native FIFREEZE qualification is still required.
Unknown release keeps this process, original FDs and lock alive indefinitely.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import time

_spec = importlib.util.spec_from_file_location("_complete_cut_raw", Path(__file__).with_name("complete_cut.py"))
raw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(raw)
SUPPORT = "/usr/lib/zeros/complete-cut-support.json"
FIFREEZE, FITHAW = 0xc0045877, 0xc0045878
REASONS = {"unsupported", "cancelled", "deadline", "source_changed", "peer_gone", "capture_failed", "custody_unknown", "diagnostics_failed"}


class CustodyFailure(Exception):
    def __init__(self, reason="capture_failed"):
        self.reason = reason if reason in REASONS else "capture_failed"
        super().__init__(self.reason)


def require(condition, reason="unsupported"):
    if not condition: raise CustodyFailure(reason)


def protected_metadata(info):
    require(info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022)


def protected_acl(fd):
    # Authority/control objects have no qualified extended-attribute profile.
    # Default ACLs can grant access without changing the visible directory mode.
    require(not os.listxattr(fd), "source_changed")


def protected_parents(path):
    for parent in reversed(Path(path).parents):
        fd = os.open(str(parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try: protected_metadata(os.fstat(fd)); protected_acl(fd)
        finally: os.close(fd)


class OriginalFile:
    def __init__(self, path, maximum):
        self.fd = None
        try:
            self.path = str(path)
            require(os.path.realpath(self.path) == self.path)
            protected_parents(self.path)
            self.fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            self.original = os.fstat(self.fd); self.mount = raw.mount_id(self.fd)
            protected_metadata(self.original); protected_acl(self.fd)
            require(stat.S_ISREG(self.original.st_mode) and self.original.st_nlink == 1
                    and stat.S_IMODE(self.original.st_mode) in (0o444, 0o555) and 0 < self.original.st_size <= maximum)
            self.content = os.read(self.fd, maximum + 1)
            require(len(self.content) == self.original.st_size)
            self.check()
        except BaseException:
            self.close(); raise

    def check(self):
        require(self.fd is not None, "custody_unknown")
        protected_parents(self.path); protected_acl(self.fd)
        require(raw.identity(self.original) == raw.identity(os.fstat(self.fd))
                == raw.identity(os.stat(self.path, follow_symlinks=False)), "source_changed")
        reopened = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        try:
            protected_acl(reopened)
            require(raw.identity(os.fstat(reopened)) == raw.identity(self.original)
                    and raw.mount_id(reopened) == self.mount == raw.mount_id(self.fd), "source_changed")
        finally: os.close(reopened)

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None; os.close(fd)


def validate_support(value):
    require(type(value) is dict and set(value) == {"version", "kind", "kernelRelease", "machine", "filesystem",
            "helperSha256", "rawSha256", "runtimeSha256", "layoutSha256", "qualificationSha256", "sources",
            "control", "cgroup", "limits", "cleanupRetryMs", "proofs"})
    require(value["version"] == 1 and value["kind"] == "complete-cut-qualification" and value["filesystem"] == "ext4"
            and value["kernelRelease"] == os.uname().release and value["machine"] == os.uname().machine)
    for field in ("helperSha256", "rawSha256", "runtimeSha256", "layoutSha256", "qualificationSha256"):
        require(type(value[field]) is str and re.fullmatch(r"[a-f0-9]{64}", value[field]))
    require(value["sources"] == {"files": "/srv/zeros/files", "state": "/srv/zeros/state",
                                 "home": "/srv/zeros/home", "repos": "/srv/zeros/repos"})
    require(type(value["control"]) is str and value["control"].startswith("/opt/zeros/")
            and type(value["cgroup"]) is str and value["cgroup"].startswith("/sys/fs/cgroup/")
            and all(os.path.realpath(value[key]) == value[key] for key in ("control", "cgroup")))
    raw.limits(value["limits"])
    require(raw.integer(value["cleanupRetryMs"], 1, 60000))
    proofs = {"allTenantWriters", "legacyAio", "mmap", "writeback", "originalObjectRelease", "peerDeath",
              "helperDeath", "signalsAndDeadlines", "independentControlFilesystem", "pauseMeasured"}
    require(type(value["proofs"]) is dict and set(value["proofs"]) == proofs
            and all(item is True for item in value["proofs"].values()))

    return value


class QualifiedSupport:
    """Retain original support and helper file/mount objects through all IO.
    Deployment qualification is external; this never installs passing support.
    """
    def __init__(self, path):
        self.references = []
        try:
            support = OriginalFile(path, 65536); self.references.append(support)
            require(stat.S_IMODE(support.original.st_mode) == 0o444)
            self.value = validate_support(raw.closed_json(support.content))
            for field, path in (("helperSha256", Path(__file__)), ("rawSha256", Path(raw.__file__))):
                source = OriginalFile(path, 1024 * 1024); self.references.append(source)
                require(hashlib.sha256(source.content).hexdigest() == self.value[field])
            self.check()
        except BaseException:
            self.close(); raise CustodyFailure("unsupported") from None

    def check(self):
        for ref in self.references: ref.check()

    def close(self):
        failed = False
        for ref in reversed(self.references):
            try: ref.close()
            except OSError: failed = True
        self.references = []
        if failed: raise CustodyFailure("custody_unknown")


def load_qualified_support(file=SUPPORT):
    """Read-only probe. The actual native monitor holds QualifiedSupport."""
    ref = QualifiedSupport(file)
    try: return ref.value
    finally: ref.close()


class OriginalDirectory:
    def __init__(self, path, protected=False):
        self.fd = None
        try:
            require(os.path.realpath(path) == path)
            self.path, self.protected = path, protected
            if protected: protected_parents(path)
            self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.original = os.fstat(self.fd); self.mount = raw.mount_id(self.fd)
            require(not self.original.st_mode & 0o002)
            if protected: protected_metadata(self.original); protected_acl(self.fd)
            self.check()
        except BaseException:
            self.close(); raise

    def check(self):
        require(self.fd is not None, "custody_unknown")
        named = os.stat(self.path, follow_symlinks=False)
        if self.protected:
            protected_parents(self.path); protected_metadata(named); protected_acl(self.fd)
        # Held mount references make these ordinary IDs non-recyclable for
        # the lifetime of the monitor. Fresh names must still reach originals.
        for info in (os.fstat(self.fd), named):
            require((info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
                    == (self.original.st_dev, self.original.st_ino, self.original.st_mode,
                        self.original.st_uid, self.original.st_gid), "source_changed")
        fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            require(raw.mount_id(fd) == self.mount == raw.mount_id(self.fd), "source_changed")
            reopened = os.fstat(fd)
            if self.protected: protected_metadata(reopened); protected_acl(fd)
            require((reopened.st_dev, reopened.st_ino) == (self.original.st_dev, self.original.st_ino), "source_changed")
        finally: os.close(fd)

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None; os.close(fd)


def mount_table():
    with open("/proc/self/mountinfo", "rb") as stream: content = stream.read(1024 * 1024 + 1)
    require(len(content) <= 1024 * 1024)
    result = {}
    for line in content.splitlines():
        fields = line.split(); require(len(fields) >= 10 and b"-" in fields)
        separator = fields.index(b"-"); require(separator + 3 < len(fields))
        identifier = int(fields[0]); require(identifier not in result)
        result[identifier] = (fields[2].decode("ascii"), fields[separator + 1].decode("ascii"), tuple(fields))
    return result


class NativeBackend:
    """Host-only facade for actual syscalls. No default Host admission adapter.

    admission_check must prove the exact original source/runtime/layout/writer,
    all-writer Host admission fence and no final-stop competitor under lock_fd.
    The separate launch boundary must keep this monitor outside that tree. Its
    executable/support freeze requires the native C1 qualification, not models.
    """
    def __init__(self, *, support, staging, lock_fd, peer_pidfd, admission_check, attempt):
        self.references, self.lock_fd, self.peer_pidfd, self.pending_fd = [], None, None, None
        self.support_reference = None
        try:
            require(os.geteuid() == 0 and callable(admission_check))
            self.support_path = support
            self.support_reference = QualifiedSupport(support)
            self.support = self.support_reference.value
            self.admission_check = admission_check
            require(type(attempt) is dict and set(attempt) == {"id", "source", "startedAtMs", "deadlineAtMs"}
                    and raw.integer(attempt["startedAtMs"]) and raw.integer(attempt["deadlineAtMs"], attempt["startedAtMs"] + 1))
            # The Host admission callback validates the full closed source and
            # original attempt under its original authority lock on every call.
            self.attempt = raw.closed_json(raw.packed(attempt))
            lock = os.fstat(lock_fd)
            require(stat.S_ISREG(lock.st_mode) and lock.st_uid == lock.st_gid == 0 and lock.st_nlink == 1
                    and stat.S_IMODE(lock.st_mode) == 0o600)
            protected_acl(lock_fd)
            self.lock_original = (lock.st_dev, lock.st_ino, lock.st_mode, lock.st_uid, lock.st_gid, lock.st_nlink)
            self.lock_fd = os.dup(lock_fd); fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(os.readlink(f"/proc/self/fd/{peer_pidfd}") == "anon_inode:[pidfd]")
            self.peer_pidfd = os.dup(peer_pidfd)
            def keep(path, protected=False):
                ref = OriginalDirectory(path, protected); self.references.append(ref); return ref
            self.control = keep(self.support["control"], True)
            self.staging = keep(staging, True)
            require(Path(staging).parent == Path(self.support["control"]) and not os.listdir(self.staging.fd)
                    and stat.S_IMODE(self.staging.original.st_mode) == 0o700)
            self.group = keep(self.support["cgroup"], True)
            with open("/proc/self/cgroup", encoding="ascii") as stream: membership = stream.read(16385)
            require(len(membership) <= 16384)
            own = re.findall(r"(?m)^0::(/[^\n]*)$", membership); require(len(own) == 1)
            relative = self.support["cgroup"][len("/sys/fs/cgroup"):]
            require(own[0] != relative and not own[0].startswith(relative + "/"))
            self.roots = {name: keep(path) for name, path in self.support["sources"].items()}
            table = mount_table(); self.table = {}
            self.sources, devices = [], set()
            for ref in self.roots.values():
                row = table.get(ref.mount)
                require(row is not None and row[1] == "ext4"
                        and row[0] == f"{os.major(ref.original.st_dev)}:{os.minor(ref.original.st_dev)}")
                self.table[ref.mount] = row
                if ref.original.st_dev not in devices:
                    self.sources.append(ref.fd); devices.add(ref.original.st_dev)
            independent = [self.control.original.st_dev, self.staging.original.st_dev, lock.st_dev,
                           os.stat("/").st_dev, os.stat("/usr").st_dev, os.stat(__file__).st_dev]
            independent += [ref.original.st_dev for ref in self.support_reference.references]
            require(not devices.intersection(independent))
            self.retry_seconds = self.support["cleanupRetryMs"] / 1000
            self.stage_guard = lambda: None
            self.check()
        except BaseException:
            self.close(); raise CustodyFailure("unsupported") from None

    def check(self):
        require(not select.select([self.peer_pidfd], [], [], 0)[0], "peer_gone")
        self.support_reference.check()
        lock = os.fstat(self.lock_fd); protected_acl(self.lock_fd)
        require((lock.st_dev, lock.st_ino, lock.st_mode, lock.st_uid, lock.st_gid, lock.st_nlink) == self.lock_original, "source_changed")
        self.admission_check(self.attempt)
        for ref in self.references: ref.check()
        table = mount_table()
        for identifier, row in self.table.items(): require(table.get(identifier) == row, "source_changed")

    def begin(self):
        # A dead monitor leaves this root-private marker. Its successor cannot
        # infer retirement from an available flock or recycled scalar IDs.
        # Only this live owner, after positive original release, removes it.
        self.pending_fd = os.open("complete-cut.pending", os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_CREAT | os.O_EXCL,
                                  0o600, dir_fd=self.control.fd)
        value = raw.packed({"version": 1, "kind": "complete-cut-pending", "attempt": self.attempt,
                            "qualificationSha256": self.support["qualificationSha256"]})
        raw.write_all(self.pending_fd, value, self.check)
        os.fsync(self.pending_fd); os.fsync(self.control.fd); self.check()
        self.pending_identity = raw.identity(os.fstat(self.pending_fd))

    def retired(self):
        require(self.pending_fd is not None, "custody_unknown")
        require(self.pending_identity == raw.identity(os.fstat(self.pending_fd))
                == raw.identity(os.stat("complete-cut.pending", dir_fd=self.control.fd, follow_symlinks=False)), "custody_unknown")
        os.unlink("complete-cut.pending", dir_fd=self.control.fd); os.fsync(self.control.fd)
        os.close(self.pending_fd); self.pending_fd = None

    def operation(self, name, index=None):
        if name in ("filesystem_freeze", "filesystem_thaw"):
            fcntl.ioctl(self.sources[index], FIFREEZE if name == "filesystem_freeze" else FITHAW, 0)
        elif name in ("group_freeze", "group_thaw"):
            fd = os.open("cgroup.freeze", os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.group.fd)
            try:
                require(os.write(fd, b"1" if name == "group_freeze" else b"0") == 1, "custody_unknown")
            finally: os.close(fd)
        elif name == "stage":
            raw.stage_raw_cut({name: ref.fd for name, ref in self.roots.items()}, self.staging.fd,
                              self.support["limits"], self.stage_guard, {0, 10003}, {0, 10003})
        else: raise CustodyFailure("unsupported")

    def group_frozen(self, frozen):
        fd = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.group.fd)
        try:
            value = os.read(fd, 4097); require(len(value) <= 4096, "custody_unknown")
            states = re.findall(rb"(?m)^frozen ([01])$", value)
            require(len(states) == 1, "custody_unknown")
            return states[0] == (b"1" if frozen else b"0")
        finally: os.close(fd)

    def stage_result(self): return raw.read_manifest(self.staging.fd, self.check)

    def close(self):
        # This is called only before any freeze, or after positive release.
        failed = False
        for ref in reversed(self.references):
            try: ref.close()
            except OSError: failed = True
        self.references = []
        for name in ("pending_fd", "peer_pidfd", "lock_fd"):
            fd = getattr(self, name, None); setattr(self, name, None)
            if fd is not None:
                try: os.close(fd)
                except OSError: failed = True
        if self.support_reference is not None:
            try: self.support_reference.close()
            except (OSError, CustodyFailure): failed = True
            self.support_reference = None
        if failed: raise CustodyFailure("custody_unknown")


class OwnedJob:
    def __init__(self, call, cancellable=False):
        self.read, write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
        self.pid, self.done, self.ok, self.cancelled = None, False, False, False
        try:
            self.pid = os.fork()
            if self.pid == 0:
                os.close(self.read)
                try:
                    def cancel(_signum, _frame): raise CustodyFailure("cancelled")
                    for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, cancel if cancellable else signal.SIG_IGN)
                    call(); os.write(write, b"ok")
                except BaseException:
                    try: os.write(write, b"failed")
                    except OSError: pass
                finally: os._exit(0)
            self.cancellable = cancellable
        except BaseException:
            os.close(self.read); raise
        finally: os.close(write)

    def poll(self):
        if self.done: return True
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if not pid: return False
        try:
            try: result = os.read(self.read, 16)
            except BlockingIOError: result = b""
            self.ok = os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 and result == b"ok"
            self.done = True; return True
        finally: os.close(self.read)

    def cancel_stage(self):
        if self.cancellable and not self.done and not self.cancelled:
            self.cancelled = True
            try: os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError: pass


def run_monitor(backend, *, wall_start_ms, attempt_ms, monotonic=time.monotonic, observe=lambda _value: None):
    """Run in the independent Host monitor, never the engine process.
    A pending job is always positively joined before its corresponding thaw.
    No finite timeout or signal may turn unconfirmed release into retirement.
    """
    try:
        require(raw.integer(wall_start_ms) and raw.integer(attempt_ms, 1, 2 ** 31 - 1))
        start = monotonic(); wall_deadline = wall_start_ms + attempt_ms
        remaining = wall_deadline - int(time.time() * 1000); require(remaining > 0, "deadline")
    except BaseException:
        backend.close(); raise
    deadline = start + min(remaining, attempt_ms) / 1000
    first, cancelled, notified = None, False, False
    group_attempted, attempted, result, cut_at, pending_owned = False, [], None, None, False
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}

    def fail(reason):
        nonlocal first
        if first is None: first = reason if reason in REASONS else "capture_failed"

    def signal_cancel(_signum, _frame):
        nonlocal cancelled
        cancelled = True

    def check():
        if cancelled: fail("cancelled")
        now = monotonic()
        if now < start or now >= deadline or int(time.time() * 1000) >= wall_deadline: fail("deadline")
        try: backend.check()
        except CustodyFailure as error: fail(error.reason)
        except BaseException: fail("source_changed")

    def report_pending():
        nonlocal notified
        if notified: return
        notified = True
        try: observe({"status": "pending", "retirement": "unknown", "reason": first or "custody_unknown"})
        except BaseException: fail("diagnostics_failed")

    def current():
        check()
        if first is not None: raise CustodyFailure(first)

    def joined(name, index=None):
        job = OwnedJob(lambda: backend.operation(name, index), cancellable=name == "stage")
        while not job.poll():
            check()
            if first is not None:
                report_pending(); job.cancel_stage()
            time.sleep(0.005)
        check()
        if not job.ok: fail("capture_failed")
        return job.ok

    def release(name, index=None):
        while True:
            try:
                if joined(name, index): return
            except BaseException: fail("custody_unknown")
            report_pending()
            # This holds original custody, not renewed attempt authority.
            time.sleep(backend.retry_seconds)

    for sig in handlers: signal.signal(sig, signal_cancel)
    try:
        try:
            current()
            backend.stage_guard = current
            backend.begin(); pending_owned = True; current()
            group_attempted = True
            if not joined("group_freeze"): raise CustodyFailure("capture_failed")
            while not backend.group_frozen(True): current(); time.sleep(0.005)
            current()
            for index in range(len(backend.sources)):
                attempted.append(index)
                if not joined("filesystem_freeze", index): raise CustodyFailure("capture_failed")
                current()
            current(); cut_at = int(time.time() * 1000)
            if not joined("stage"): raise CustodyFailure("capture_failed")
            current(); result = backend.stage_result(); current()
        except CustodyFailure as error: fail(error.reason)
        except BaseException: fail("capture_failed")
        finally:
            # Release through the original references even after named proof,
            # peer custody, cancellation or the original deadline has failed.
            for index in reversed(attempted): release("filesystem_thaw", index)
            if group_attempted:
                release("group_thaw")
                while True:
                    try:
                        if backend.group_frozen(False): break
                    except BaseException: fail("custody_unknown")
                    check(); report_pending(); time.sleep(backend.retry_seconds)
        check()
        try: observe({"status": "released", "retirement": "confirmed", "reason": first})
        except BaseException: fail("diagnostics_failed")
        check()
        if pending_owned:
            while True:
                try: backend.retired(); break
                except BaseException:
                    fail("custody_unknown"); report_pending(); time.sleep(backend.retry_seconds)
            check()
        backend.close()
        if cancelled: fail("cancelled")
        if monotonic() >= deadline or int(time.time() * 1000) >= wall_deadline: fail("deadline")
        if first is not None: return {"status": "failed", "retirement": "confirmed", "reason": first}
        require(result is not None and cut_at is not None, "custody_unknown")
        return {"status": "staged", "retirement": "confirmed", "cutAtMs": cut_at, "manifest": result}
    finally:
        for sig, handler in handlers.items(): signal.signal(sig, handler)
