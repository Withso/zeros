"""Real owned jobs/signals/descriptors; synthetic freeze IO, not qualification."""
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import stat
import struct
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "complete_cut_custody.py"
c = None
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location("complete_cut_custody", SOURCE)
    c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)


class ProjectedBackend:
    """Native syscalls alone are modeled; monitor/jobs/FDs/signals are real."""
    def __init__(self, root, audit, hold, fault, late):
        self.root, self.audit, self.hold, self.fault, self.late = root, audit, hold, fault, late
        self.sources = [os.open(root / "source", os.O_RDONLY | os.O_DIRECTORY)]
        self.control = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        self.original = os.fstat(self.sources[0])
        self.retry_seconds = 0.01
        self.closed = False

    def emit(self, value): os.write(self.audit, (value + "\n").encode())

    def begin(self):
        with (self.root / "pending").open("x") as stream:
            stream.write("original-attempt"); stream.flush(); os.fsync(stream.fileno())
        os.fsync(self.control); self.emit("pending")

    def retired(self):
        (self.root / "pending").unlink(); os.fsync(self.control); self.emit("retired")

    def check(self):
        if self.closed: raise RuntimeError()
        if (self.root / "changed").exists(): raise c.CustodyFailure("source_changed")
        self.emit("check")

    def operation(self, name, index=None):
        self.emit(name)
        if name == self.fault:
            self.emit("held")
            os.read(self.hold, 1)
            if self.late == "exit": os._exit(9)
            if self.late == "fail": raise RuntimeError()
        if name == "filesystem_thaw":
            if os.fstat(self.sources[index]).st_ino != self.original.st_ino: raise RuntimeError()
            (self.root / "original-released").write_text("yes")
        if name == "stage":
            (self.root / "raw-cut").write_text("immutable")

    def group_frozen(self, frozen): self.emit("frozen" if frozen else "resumed"); return True
    def stage_result(self): return {"inventorySha256": "a" * 64}
    def close(self):
        for fd in self.sources: os.close(fd)
        os.close(self.control); self.closed = True; self.emit("closed")


class CutCustodyTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(c, "outside cut custody must exist before enrollment")
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); (self.root / "source").mkdir()
        self.children = []
        self.addCleanup(self.reap)

    def reap(self):
        for pid in self.children:
            # Only this synthetic syscall fixture owns the process group.
            # Kill/reap its whole job tree even if the monitor already died.
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try:
                result = os.waitpid(pid, os.WNOHANG)
                if result[0] == 0: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
            except ChildProcessError: pass

    def launch(self, fault="", late="", diagnostic=False, expiry=False):
        audit_read, audit_write = os.pipe(); hold_read, hold_write = os.pipe(); result_read, result_write = os.pipe()
        for fd in (audit_read, audit_write, hold_read, hold_write, result_read, result_write): self.addCleanup(os.close, fd)
        pid = os.fork()
        if pid == 0:
            try:
                os.setsid()
                backend = ProjectedBackend(self.root, audit_write, hold_read, fault, late)
                original = time.monotonic()
                def clock():
                    return original + (2 if (self.root / "expired").exists() else 0)
                def observe(value):
                    backend.emit("observation")
                    if diagnostic: raise RuntimeError("private fixture details")
                outcome = c.run_monitor(backend, wall_start_ms=int(time.time() * 1000), attempt_ms=1000,
                                        monotonic=clock if expiry else time.monotonic, observe=observe)
                os.write(result_write, json.dumps(outcome).encode())
            except BaseException:
                os.write(result_write, b'{"unexpected":true}')
            finally: os._exit(0)
        self.children.append(pid)
        return pid, audit_read, hold_write, result_read

    def wait_for(self, fd, word):
        seen = b""; deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not select.select([fd], [], [], 0.1)[0]: continue
            seen += os.read(fd, 4096)
            if word.encode() + b"\n" in seen: return seen.decode().splitlines()
        self.fail("owned process did not reach the retained boundary")

    def result(self, pid, fd):
        self.assertTrue(select.select([fd], [], [], 5)[0], "monitor did not positively settle")
        value = json.loads(os.read(fd, 16384)); os.waitpid(pid, 0); self.children.remove(pid)
        return value

    def test_positive_cut_thaws_original_filesystem_before_group_and_releases_refs(self):
        pid, audit, hold, result = self.launch()
        value = self.result(pid, result)
        trace = self.wait_for(audit, "closed")
        self.assertEqual(value["status"], "staged")
        self.assertEqual(value["retirement"], "confirmed")
        self.assertLess(trace.index("filesystem_freeze"), trace.index("stage"))
        self.assertIn("pending", trace)
        self.assertLess(trace.index("pending"), trace.index("group_freeze"))
        self.assertLess(trace.index("filesystem_thaw"), trace.index("group_thaw"))
        self.assertLess(trace.index("resumed"), trace.index("closed"))
        self.assertFalse((self.root / "pending").exists())

    def test_monitor_death_keeps_durable_pending_and_successor_cannot_clear_it(self):
        pid, audit, hold, result = self.launch("filesystem_freeze")
        self.wait_for(audit, "held")
        self.assertTrue((self.root / "pending").exists())
        os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
        # Do not remove this pid from group cleanup: its owned job remains.
        next_pid, next_audit, next_hold, next_result = self.launch()
        value = self.result(next_pid, next_result)
        self.assertEqual(value["status"], "failed")
        self.assertEqual((self.root / "pending").read_text(), "original-attempt")
        self.assertFalse((self.root / "original-released").exists())

    def test_repeated_signals_join_the_pending_freeze_before_any_thaw(self):
        pid, audit, hold, result = self.launch("filesystem_freeze")
        self.wait_for(audit, "held")
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGTERM): os.kill(pid, sig)
        self.wait_for(audit, "observation")
        self.assertFalse((self.root / "original-released").exists())
        self.assertFalse(select.select([result], [], [], 0)[0])
        os.write(hold, b"x")
        value = self.result(pid, result)
        self.assertEqual(value, {"status": "failed", "retirement": "confirmed", "reason": "cancelled"})
        self.assertTrue((self.root / "original-released").exists())
        self.assertFalse((self.root / "raw-cut").exists())

    def test_original_deadline_does_not_restart_after_a_late_freeze_completion(self):
        pid, audit, hold, result = self.launch("filesystem_freeze", expiry=True)
        self.wait_for(audit, "held"); (self.root / "expired").write_text("yes")
        self.wait_for(audit, "observation"); self.assertFalse(select.select([result], [], [], 0)[0])
        os.write(hold, b"x")
        self.assertEqual(self.result(pid, result)["reason"], "deadline")
        self.assertFalse((self.root / "raw-cut").exists())

    def test_named_source_replacement_still_releases_through_original_refs(self):
        pid, audit, hold, result = self.launch("stage")
        self.wait_for(audit, "held")
        (self.root / "source").rename(self.root / "old"); (self.root / "source").mkdir()
        (self.root / "changed").write_text("yes"); os.write(hold, b"x")
        value = self.result(pid, result)
        self.assertEqual(value["reason"], "source_changed")
        self.assertTrue((self.root / "original-released").exists())

    def test_owned_freeze_worker_death_is_ambiguous_until_original_thaw_succeeds(self):
        pid, audit, hold, result = self.launch("filesystem_freeze", "exit")
        self.wait_for(audit, "held"); os.write(hold, b"x")
        value = self.result(pid, result)
        self.assertEqual(value["status"], "failed")
        self.assertEqual(value["retirement"], "confirmed")
        self.assertTrue((self.root / "original-released").exists())

    def test_diagnostics_failure_is_after_release_and_cannot_leak_descriptors(self):
        pid, audit, hold, result = self.launch(diagnostic=True)
        value = self.result(pid, result); trace = self.wait_for(audit, "closed")
        self.assertEqual(value["status"], "failed")
        self.assertLess(trace.index("resumed"), trace.index("closed"))
        self.assertTrue((self.root / "original-released").exists())

    def test_unknown_thaw_retains_monitor_refs_and_never_resumes_group(self):
        pid, audit, hold, result = self.launch("filesystem_thaw", "fail")
        trace = self.wait_for(audit, "held"); os.write(hold, b"x")
        trace += self.wait_for(audit, "observation")
        self.assertNotIn("group_thaw", trace); self.assertNotIn("closed", trace)
        self.assertFalse(select.select([result], [], [], 0)[0])
        # The modeled failing thaw has no kernel side effects. Teardown may
        # kill this fixture monitor; doing that on an actual frozen FS is unsafe.

    def test_absent_support_refuses_without_opening_sources_or_starting_a_job(self):
        self.assertTrue(callable(getattr(c, "load_qualified_support", None)))
        with self.assertRaises(c.CustodyFailure): c.load_qualified_support(self.root / "absent")

    def test_support_reference_holds_original_bytes_and_refuses_identical_replacement(self):
        self.assertTrue(callable(getattr(c, "OriginalFile", None)), "support requires original file custody, not reread scalar content")
        file = self.root / "support"; file.write_bytes(b"frozen fixture policy"); file.chmod(0o444)
        # Root authority is not claimed by this rootless original-FD projection.
        with patch.object(c, "protected_metadata", lambda info: None), patch.object(c, "protected_parents", lambda path: None):
            ref = c.OriginalFile(str(file), 65536)
            fd = ref.fd
            try:
                self.assertEqual(ref.content, b"frozen fixture policy")
                file.rename(self.root / "prior")
                file.write_bytes(ref.content); file.chmod(0o444)
                with self.assertRaises(c.CustodyFailure): ref.check()
                self.assertEqual(os.fstat(fd).st_ino, (self.root / "prior").stat().st_ino)
            finally: ref.close()
        with self.assertRaises(OSError): os.fstat(fd)

    def test_protected_reference_rechecks_real_default_acl(self):
        directory = str(self.root / "source")
        with patch.object(c.os, "fstat", wraps=os.fstat):
            # Project only the original root ownership check; the actual ACL,
            # mode, inode and descriptor reads remain real.
            with patch.object(c, "protected_metadata", lambda info: None, create=True), patch.object(c, "protected_parents", lambda path: None, create=True):
                ref = c.OriginalDirectory(directory, False)
                ref.protected = True
                fd = ref.fd
                try:
                    ref.check()
                    acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", tag, 7, 0xffffffff) for tag in (1, 4, 32))
                    os.setxattr(fd, "system.posix_acl_default", acl)
                    with self.assertRaises(c.CustodyFailure): ref.check()
                finally: ref.close()

    def test_expired_initial_admission_closes_refs_without_freeze_or_pending(self):
        audit_read, audit_write = os.pipe(); hold_read, hold_write = os.pipe()
        for fd in (audit_read, audit_write, hold_read, hold_write): self.addCleanup(os.close, fd)
        backend = ProjectedBackend(self.root, audit_write, hold_read, "", "")
        fd = backend.sources[0]
        try:
            with self.assertRaises(c.CustodyFailure):
                c.run_monitor(backend, wall_start_ms=int(time.time() * 1000) - 1000, attempt_ms=1)
            self.assertTrue(backend.closed, "no-custody refusal must release acquired original references")
            self.assertFalse((self.root / "pending").exists())
        finally:
            if not backend.closed: backend.close()
        with self.assertRaises(OSError): os.fstat(fd)

    def test_qualification_cannot_omit_the_persistent_repository_root(self):
        value = {"version": 1, "kind": "complete-cut-qualification", "kernelRelease": os.uname().release,
                 "machine": os.uname().machine, "filesystem": "ext4", "sources": {"files": "/srv/zeros/files",
                 "state": "/srv/zeros/state", "home": "/srv/zeros/home"}, "control": "/opt/zeros/fixture-cut",
                 "cgroup": "/sys/fs/cgroup/fixture-cut", "cleanupRetryMs": 25,
                 "limits": {"maxEntries": 100, "maxBytes": 1024, "readBytes": 4096, "maxMetadataBytes": 4096},
                 "proofs": {name: True for name in ("allTenantWriters", "legacyAio", "mmap", "writeback", "originalObjectRelease",
                  "peerDeath", "helperDeath", "signalsAndDeadlines", "independentControlFilesystem", "pauseMeasured")}}
        value.update({name: "a" * 64 for name in ("helperSha256", "rawSha256", "runtimeSha256", "layoutSha256", "qualificationSha256")})
        # This exercises only closed profile shape, not any qualified support.
        with self.assertRaises(c.CustodyFailure): c.validate_support(value)
        value["sources"]["repos"] = "/srv/zeros/repos"
        self.assertEqual(c.validate_support(value)["sources"], value["sources"])
