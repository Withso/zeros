"""Whole-pass contention keeps the actual descriptor, ACL and sealed-policy fences."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("stability_fixture", Path(__file__).with_name("test_optional_systemd.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
b = fixture.b
ACL = "system.posix_acl_default"
ACL_BYTES = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in (
    (1, 7, 0xffffffff), (2, 7, 10003), (4, 5, 0xffffffff), (16, 7, 0xffffffff), (32, 5, 0xffffffff)))


class StabilityFixture(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.OptionalSystemdTests("test_stock_provider_owned_ancestors_need_sealed_qualification")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.app, self.root = self.fixture.app, self.fixture.root
        self.policy = self.fixture.qualify()
        self.clock, self.attempts, self.sleeps = 0.0, 0, []

    def absolute(self, name, kwargs):
        return (Path(os.readlink(f"/proc/self/fd/{kwargs['dir_fd']}")) / name
                if kwargs.get("dir_fd") is not None else Path(name))

    def churn(self, target):
        before = target.stat()
        sibling = target / "unrelated-provider-tool"
        sibling.write_bytes(b"public fixture")
        sibling.unlink()
        after = target.stat()
        if (before.st_mtime_ns, before.st_ctime_ns) == (after.st_mtime_ns, after.st_ctime_ns):
            os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns + 1000000))
            after = target.stat()
        core = lambda st: (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid)
        self.assertEqual(core(before), core(after))
        self.assertNotEqual((before.st_mtime_ns, before.st_ctime_ns), (after.st_mtime_ns, after.st_ctime_ns))

    def history(self):
        path = self.root / "run/zeros/optional-systemd-observations.jsonl"
        return [json.loads(line) for line in path.read_bytes().splitlines()] if path.exists() else []

    def observe(self, on_open=lambda *_: None, on_sleep=lambda *_: None):
        original_open, original_close, original_mount = b.os.open, b.os.close, self.app.mounts.mount_id
        directories, roots, started, counts = set(), set(), set(), {}

        def opening(name, flags, *args, **kwargs):
            absolute = self.absolute(name, kwargs)
            key = (self.attempts, absolute)
            counts[key] = counts.get(key, 0) + 1
            on_open(absolute, counts[key], self.attempts)
            fd = original_open(name, flags, *args, **kwargs)
            if flags & os.O_DIRECTORY:
                self.assertNotIn(fd, directories)
                directories.add(fd)
            if absolute == self.root and "dir_fd" not in kwargs:
                roots.add(fd)
            return fd

        def closing(fd):
            original_close(fd)
            directories.discard(fd)
            roots.discard(fd)
            started.discard(fd)

        def mounted(fd):
            # Logging also opens the root, but never asks its mount identity.
            # Only the first mount observation of an original proof root starts a pass.
            if fd in roots and fd not in started:
                self.attempts += 1
                started.add(fd)
            return original_mount(fd)

        def sleep(seconds):
            self.assertEqual(directories, set(), "a discarded pass must release every directory before backoff")
            self.sleeps.append(seconds)
            self.clock += seconds
            on_sleep(seconds)

        result, error = None, None
        with mock.patch.object(b.os, "open", side_effect=opening), mock.patch.object(b.os, "close", side_effect=closing), \
                mock.patch.object(self.app.mounts, "mount_id", side_effect=mounted), \
                mock.patch.object(b.time, "monotonic", side_effect=lambda: self.clock), \
                mock.patch.object(b.time, "sleep", side_effect=sleep):
            try:
                result = self.fixture.verify(self.policy)
            except b.Failure as failure:
                error = failure
        self.assertEqual(directories, set(), "all proof and logging descriptors must close on every outcome")
        return result, error

    def refusal(self, on_open, **kwargs):
        result, error = self.observe(on_open, **kwargs)
        self.assertIsNone(result)
        self.assertIsNotNone(error)
        self.assertEqual(error.checks, ["base_compatibility"])

    def churn_at(self, relative, opening=1, attempts=(1,)):
        target = self.root / relative
        return lambda path, number, attempt: self.churn(target) if path == target and number == opening and attempt in attempts else None


class OptionalSystemdStabilityTests(StabilityFixture):
    def assert_recovers(self, relative, opening):
        result, error = self.observe(self.churn_at(relative, opening))
        self.assertIsNone(error, "a real unrelated sibling write must permit a new complete strict pass")
        self.assertEqual(result, self.policy["snapshot"])
        self.assertEqual(self.attempts, 2)
        self.assertEqual(self.sleeps, [0.025])
        record = self.history()[-1]
        self.assertEqual((record["outcome"], record["retryCount"], record["terminalCheck"]), ("recovered", 1, "none"))
        self.assertTrue(record["comparisons"])
        self.assertTrue(all(row["mountCheck"] == "equal" and row["retryCount"] == 0 for row in record["comparisons"]))

    def test_provider_local_initial_sibling_write_recovers(self):
        self.assert_recovers("usr/local", 1)

    def test_provider_lib_initial_sibling_write_recovers(self):
        self.assert_recovers("usr/local/lib", 1)

    def test_provider_local_final_reopen_sibling_write_recovers(self):
        self.assert_recovers("usr/local", 2)

    def test_provider_lib_final_reopen_sibling_write_recovers(self):
        self.assert_recovers("usr/local/lib", 2)

    def test_two_complete_discarded_passes_then_stable_third_pass(self):
        result, error = self.observe(self.churn_at("usr/local", attempts=(1, 2)))
        self.assertIsNone(error)
        self.assertEqual(result, self.policy["snapshot"])
        self.assertEqual((self.attempts, self.sleeps), (3, [0.025, 0.05]))
        record = self.history()[-1]
        self.assertEqual((record["outcome"], record["retryCount"]), ("recovered", 2))
        self.assertEqual({row["retryCount"] for row in record["comparisons"]}, {0, 1})

    def test_sustained_churn_refuses_after_three_complete_passes(self):
        self.refusal(self.churn_at("usr/local", attempts=(1, 2, 3, 4)))
        self.assertEqual((self.attempts, self.sleeps), (3, [0.025, 0.05]))
        record = self.history()[-1]
        self.assertEqual((record["outcome"], record["terminalCheck"], record["retryCount"]), ("attempt_limit", "attempt_limit", 2))
        self.assertEqual({row["retryCount"] for row in record["comparisons"]}, {0, 1, 2})

    def test_first_contended_pass_already_past_original_deadline_cannot_retry(self):
        churn = self.churn_at("usr/local")
        def change(path, number, attempt):
            churn(path, number, attempt)
            if path == self.fixture.local and number == 2:
                self.clock += 0.6
        self.refusal(change)
        self.assertEqual((self.attempts, self.sleeps), (1, []))
        self.assertTrue(self.history(), "deadline refusal needs closed history")
        self.assertEqual(self.history()[-1]["outcome"], "deadline")

    def test_backoff_is_capped_and_expiry_cannot_start_another_pass(self):
        churn = self.churn_at("usr/local")
        def change(path, number, attempt):
            churn(path, number, attempt)
            if path == self.fixture.local and number == 2:
                self.clock += 0.49
        self.refusal(change)
        self.assertEqual(self.attempts, 1)
        self.assertEqual(len(self.sleeps), 1)
        self.assertAlmostEqual(self.sleeps[0], 0.01)
        self.assertEqual(self.history()[-1]["retryCount"], 0)

    def test_late_successful_retry_cannot_publish_after_original_deadline(self):
        churn = self.churn_at("usr/local")
        def change(path, number, attempt):
            churn(path, number, attempt)
            if attempt == 2 and path == self.fixture.local and number == 2:
                self.clock += 0.6
        self.refusal(change)
        self.assertEqual(self.attempts, 2)
        self.assertEqual(self.history()[-1]["outcome"], "deadline")

    def test_slow_uncontended_first_pass_keeps_existing_outer_deadline(self):
        def change(path, number, attempt):
            if path == self.fixture.local and number == 2:
                self.clock += 0.7
        result, error = self.observe(change)
        self.assertIsNone(error)
        self.assertEqual(result, self.policy["snapshot"])
        self.assertEqual((self.attempts, self.sleeps), (1, []))
        self.assertTrue(self.history(), "stable observations must be recorded when the write succeeds")
        self.assertEqual((self.history()[-1]["outcome"], self.history()[-1]["comparisons"]), ("stable", []))

    def test_diagnostic_io_cannot_extend_retry_acceptance(self):
        original = self.app.atomic
        writes = []
        def writing(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path.endswith("optional-systemd-observations.jsonl"):
                writes.append(path)
                self.clock += 0.6
            return result
        with mock.patch.object(self.app, "atomic", side_effect=writing):
            self.refusal(self.churn_at("usr/local"))
        self.assertEqual(len(writes), 1)
        self.assertEqual(self.attempts, 2)

    def test_completed_discarded_pass_must_match_original_sealed_policy(self):
        target = self.fixture.local / "lib/systemd"
        churn = self.churn_at("usr/local")
        def change(path, number, attempt):
            churn(path, number, attempt)
            if path == self.fixture.local and number == 1 and attempt == 1:
                target.mkdir()
        self.refusal(change, on_sleep=lambda _: target.rmdir())
        self.assertTrue(target.is_dir(), "the observed policy mismatch must refuse before backoff can erase it")
        self.assertEqual((self.attempts, self.sleeps), (1, []))
        self.assertTrue(self.history(), "a completed mismatching pass must retain the stronger refusal")
        self.assertEqual(self.history()[-1]["terminalCheck"], "policy")

    def test_late_real_acl_on_each_provider_ancestor_refuses_without_retry(self):
        for target in (self.fixture.local, self.fixture.local / "lib"):
            with self.subTest(ancestor=target.name):
                self.attempts, self.sleeps = 0, []
                installed = []
                before = target.stat()
                def change(path, number, attempt):
                    if path == target and number == 2 and attempt == 1:
                        os.setxattr(target, ACL, ACL_BYTES)
                        installed.append(True)
                try:
                    self.refusal(change)
                    self.assertEqual(installed, [True])
                    self.assertIn(ACL, os.listxattr(target))
                    self.assertEqual(before.st_mode, target.stat().st_mode)
                    self.assertEqual((self.attempts, self.sleeps), (1, []))
                finally:
                    if ACL in os.listxattr(target):
                        os.removexattr(target, ACL)

    def test_pending_contention_cannot_hide_acl_on_later_reopened_descriptor(self):
        target = self.fixture.local / "lib"
        churn = self.churn_at("usr/local")
        def change(path, number, attempt):
            churn(path, number, attempt)
            if path == target and number == 2 and attempt == 1:
                os.setxattr(target, ACL, ACL_BYTES)
        self.refusal(change)
        self.assertIn(ACL, os.listxattr(target))
        self.assertEqual((self.attempts, self.sleeps), (1, []))

    def test_stronger_violation_wins_even_after_contention_deadline(self):
        churn = self.churn_at("usr/local")
        def change(path, number, attempt):
            churn(path, number, attempt)
            if path == self.fixture.local / "lib" and number == 2:
                self.clock += 0.6
                path.chmod(0o777)
        self.refusal(change)
        self.assertEqual((self.attempts, self.sleeps), (1, []))
        self.assertTrue(self.history(), "stronger observed refusal must not be relabeled deadline")
        self.assertEqual((self.history()[-1]["outcome"], self.history()[-1]["terminalCheck"]), ("refused", "metadata"))

    def test_only_exact_provider_pair_and_fixed_ancestors_allow_contention(self):
        targets = [self.root / "usr", self.fixture.local]
        self.fixture.owners.pop(self.fixture.local)
        self.policy = self.fixture.qualify()
        for target in targets:
            with self.subTest(ancestor=target.name):
                self.attempts, self.sleeps = 0, []
                self.refusal(self.churn_at(str(target.relative_to(self.root)), 2))
                self.assertEqual((self.attempts, self.sleeps), (1, []))

    def test_unrelated_io_failure_is_never_a_contention_retry(self):
        def change(path, number, attempt):
            if path == self.fixture.local and number == 1:
                raise OSError("private-error-canary")
        self.refusal(change)
        self.assertEqual((self.attempts, self.sleeps), (1, []))
        self.assertNotIn("private-error-canary", json.dumps(self.history()))

    def test_mount_observation_preserves_outer_signal_and_timeout_failures(self):
        original = self.app.mounts.mount_id
        for check in ("timeout", "process_signal"):
            with self.subTest(check=check):
                self.attempts, self.sleeps = 0, []
                interruption = b.Failure(check)
                def mounted(fd):
                    value = original(fd)
                    if Path(os.readlink(f"/proc/self/fd/{fd}")) == self.fixture.local:
                        raise interruption
                    return value
                with mock.patch.object(self.app.mounts, "mount_id", side_effect=mounted):
                    result, error = self.observe()
                self.assertIsNone(result)
                self.assertIs(error, interruption, "comparison diagnostics cannot relabel the command's interruption")
                self.assertEqual((self.attempts, self.sleeps), (1, []))

    def test_success_logging_preserves_outer_signal_and_timeout_failures(self):
        for check in ("timeout", "process_signal"):
            with self.subTest(check=check):
                self.attempts, self.sleeps = 0, []
                interruption = b.Failure(check)
                with mock.patch.object(self.app, "atomic", side_effect=interruption):
                    result, error = self.observe()
                self.assertIsNone(result, "best-effort logging must not swallow an admission interruption")
                self.assertIs(error, interruption)
                self.assertEqual((self.attempts, self.sleeps), (1, []))

    def test_retry_cannot_refresh_the_callers_original_policy(self):
        surface = self.fixture.local / "lib/systemd"
        def changed(_):
            surface.mkdir()
            self.policy["snapshot"]["absent"] = "/usr/local/lib/systemd/system"
            self.policy["snapshot"]["ancestors"]["/usr/local/lib/systemd"] = {
                "uid": self.app.uid, "gid": self.app.gid, "mode": 0o755, "acl": []}
        self.refusal(self.churn_at("usr/local"), on_sleep=changed)
        self.assertEqual(self.attempts, 2)
        self.assertEqual(self.history()[-1]["terminalCheck"], "policy")

    def test_real_acl_after_reopened_acl_read_is_seen_before_retry(self):
        for target in (self.fixture.local, self.fixture.local / "lib"):
            with self.subTest(ancestor=target.name):
                self.attempts, self.sleeps = 0, []
                original = b.os.listxattr
                reads, installed = [], False
                def listing(fd):
                    nonlocal installed
                    names = original(fd)
                    if isinstance(fd, int) and Path(os.readlink(f"/proc/self/fd/{fd}")) == target:
                        reads.append(tuple(names))
                        if len(reads) == 3:
                            os.setxattr(target, ACL, ACL_BYTES)
                            installed = True
                    return names
                try:
                    with mock.patch.object(b.os, "listxattr", side_effect=listing):
                        self.refusal(lambda *_: None)
                    self.assertTrue(installed)
                    self.assertIn(ACL, reads[-1], "fresh classification must observe the actual late ACL")
                    self.assertEqual((self.attempts, self.sleeps), (1, []))
                finally:
                    if ACL in os.listxattr(target):
                        os.removexattr(target, ACL)


if __name__ == "__main__":
    unittest.main()
