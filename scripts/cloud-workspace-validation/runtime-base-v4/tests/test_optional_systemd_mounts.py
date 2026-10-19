"""Exercise actual strict passes and FD lifetime with rootless mount models."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


stability = load("mount_stability", HERE / "test_optional_systemd_stability.py")
mounts = load("native_mount_fixture", HERE / "mount_fixture.py")
b = stability.b


class MountFixture(stability.StabilityFixture):
    def setUp(self):
        super().setUp()
        self.mounts = mounts.NativeMounts(self.root)
        self.app.mounts = self.mounts
        self.policy = self.fixture.qualify()
        self.live_at_sleep, self.live_at_log = [], []

    def observe(self, on_open=lambda *_: None, on_sleep=lambda *_: None,
                on_log=lambda: None, via_main=False):
        original_pass, original_log = self.app._optional_systemd_pass, self.app.append_private_diagnostic
        counts = {}

        def run_pass(*args, **kwargs):
            self.attempts += 1
            return original_pass(*args, **kwargs)

        def sleep(seconds):
            self.live_at_sleep.append(tuple(self.mounts.logical(fd) for fd in self.mounts.fds))
            self.sleeps.append(seconds)
            self.clock += seconds
            on_sleep(seconds)

        def log(path, value):
            if path == b.OPTIONAL_SYSTEMD_OBSERVATIONS:
                self.live_at_log.append(tuple(self.mounts.logical(fd) for fd in self.mounts.fds))
                on_log()
            return original_log(path, value)

        result, error = None, None
        with self.mounts.track(), mock.patch.object(self.app, "_optional_systemd_pass", side_effect=run_pass), \
                mock.patch.object(self.app, "append_private_diagnostic", side_effect=log), \
                mock.patch.object(b.time, "monotonic", side_effect=lambda: self.clock), \
                mock.patch.object(b.time, "sleep", side_effect=sleep):
            original_open = os.open
            def opening(name, flags, *args, **kwargs):
                path = self.absolute(name, kwargs)
                key = (self.attempts, path)
                counts[key] = counts.get(key, 0) + 1
                on_open(path, counts[key], self.attempts)
                return original_open(name, flags, *args, **kwargs)
            with mock.patch.object(b.os, "open", side_effect=opening):
                try:
                    if via_main:
                        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)}
                        previous_umask = os.umask(0o077)
                        try:
                            with mock.patch.object(b, "Bootstrap", return_value=self.app), \
                                    mock.patch.object(b.os, "geteuid", return_value=0), \
                                    mock.patch.object(self.app, "boot", side_effect=lambda: self.fixture.verify(self.policy)), \
                                    contextlib.redirect_stdout(io.StringIO()):
                                result = b.main(["boot"])
                        finally:
                            os.umask(previous_umask)
                            for sig, handler in previous.items():
                                signal.signal(sig, handler)
                    else:
                        result = self.fixture.verify(self.policy)
                except BaseException as caught:
                    error = caught
        self.assertFalse(self.mounts.fds, "every per-pass and outer anchor FD must close")
        return result, error


class OptionalSystemdMountTests(MountFixture):
    def test_fixed_native_usr_split_accepts_the_same_sealed_policy(self):
        self.mounts.add("/usr")
        result, error = self.observe()
        self.assertIsNone(error)
        self.assertEqual(result, self.policy["snapshot"])
        self.assertEqual(self.history()[-1]["anchorChecks"], [{"retryCount": 0, "root": "native_ext4", "usr": "split_ext4"}])

    def test_root_shared_and_split_qualification_keep_mount_ids_out_of_policy(self):
        self.mounts.add("/usr")
        error = None
        try:
            result = self.fixture.qualify()
        except b.Failure as caught:
            result, error = None, caught
        self.assertIsNone(error)
        self.assertEqual(result, self.policy)

    def test_non_native_root_or_usr_is_terminal_without_retry(self):
        for path in ("/", "/usr"):
            for filesystem in ("fuse.ascii-lazyfs", "overlay", "unknown"):
                with self.subTest(path=path, filesystem=filesystem):
                    self.app.mounts = self.mounts = mounts.NativeMounts(self.root, split="/usr" if path == "/usr" else None)
                    self.mounts.entries[path]["filesystem"] = filesystem
                    self.refusal(lambda *_: None)
                    self.assertEqual(self.sleeps, [])

    def test_missing_duplicate_target_id_or_wrong_device_never_qualifies(self):
        for variant in ("missing", "id", "target", "device", "duplicate_id", "duplicate_target"):
            with self.subTest(variant=variant):
                rows = self.mounts.table()
                if variant == "missing": rows = []
                elif variant == "id": rows[0]["id"] += 100
                elif variant == "target": rows[0]["target"] += "/other"
                elif variant == "device": rows[0]["device"] = "0:0"
                elif variant == "duplicate_id": rows.append(dict(rows[0], target=str(self.root / "other")))
                else: rows.append(dict(rows[0], id=rows[0]["id"] + 100))
                with mock.patch.object(self.mounts, "table", return_value=rows):
                    self.refusal(lambda *_: None)
                self.assertEqual(self.sleeps, [])

    def test_provider_owned_usr_cannot_be_an_anchor(self):
        self.mounts.add("/usr")
        self.fixture.owners[self.root / "usr"] = (4242, 4242)
        self.refusal(lambda *_: None)
        self.assertEqual(self.history()[-1]["terminalCheck"], "metadata")

    def test_child_mounts_remain_terminal_under_the_usr_anchor(self):
        self.mounts.add("/usr")
        for path in ("/usr/local", "/usr/local/lib"):
            with self.subTest(path=path):
                self.mounts.add(path)
                self.refusal(lambda *_: None)
                self.assertEqual(self.history()[-1]["terminalCheck"], "mount")
                self.mounts.entries.pop(path)["attached"] = False

    def test_stable_recovery_keeps_two_noninheritable_anchors_through_sleep_and_logging(self):
        def sleeping(_):
            self.assertEqual(len(self.mounts.fds), 2)
            self.assertTrue(all(not os.get_inheritable(fd) for fd in self.mounts.fds))
        result, error = self.observe(self.churn_at("usr/local", attempts=(1, 2)), on_sleep=sleeping)
        self.assertIsNone(error)
        self.assertEqual(result, self.policy["snapshot"])
        self.assertEqual(self.live_at_sleep, [("/", "/usr"), ("/", "/usr")])
        self.assertEqual(self.live_at_log, [("/", "/usr")])
        self.assertEqual(self.sleeps, [0.025, 0.05])

    def test_same_id_different_generation_during_backoff_cannot_pass(self):
        replacement = []
        def replacing(_):
            replacement.append(self.mounts.replace("/"))
        self.refusal(self.churn_at("usr/local"), on_sleep=replacing)
        self.assertEqual(len(replacement), 1)
        old, new = replacement[0]
        self.assertNotEqual(old["generation"], new["generation"])
        self.assertNotEqual(old["id"], new["id"], "held original mount must prevent ordinary-ID reuse")
        self.assertEqual(self.history()[-1]["terminalCheck"], "mount")

    def test_split_anchor_replacement_during_backoff_is_refused(self):
        self.mounts.add("/usr")
        replaced = []
        def replacing(_):
            replaced.append(self.mounts.replace("/usr"))
        self.refusal(self.churn_at("usr/local"), on_sleep=replacing)
        self.assertEqual(len(replaced), 1)
        self.assertNotEqual(replaced[0][0]["id"], replaced[0][1]["id"])

    def test_new_call_can_requalify_ids_without_reusing_an_old_anchor(self):
        self.assertIsNone(self.observe()[1])
        old, new = self.mounts.replace("/")
        self.assertEqual(old["id"], new["id"])
        self.assertIsNone(self.observe()[1])

    def test_partial_acquisition_io_refusal_releases_the_root_anchor(self):
        def fail(path, number, attempt):
            if path == self.root / "usr" and number == 1:
                raise OSError("fixture acquisition failure")
        self.refusal(fail)
        self.assertEqual(self.sleeps, [])

    def test_second_anchor_dup_failure_releases_every_acquired_descriptor(self):
        original, calls = os.dup, []
        def duplicate(fd):
            calls.append(fd)
            if len(calls) == 2:
                raise OSError("fixture second reference failure")
            return original(fd)
        with mock.patch.object(os, "dup", side_effect=duplicate):
            self.refusal(lambda *_: None)
        self.assertEqual(len(calls), 2)

    def test_late_root_table_failure_remains_closed_after_usr_was_validated(self):
        original, calls = self.mounts.table, []
        def table():
            rows = original()
            calls.append(True)
            if len(calls) >= 4:
                rows[0]["device"] = "0:0"
            return rows
        before = len(self.history())
        with mock.patch.object(self.mounts, "table", side_effect=table):
            self.refusal(self.churn_at("usr/local"))
        self.assertEqual(len(self.history()), before + 1)
        row = self.history()[-1]
        self.assertEqual(row["terminalCheck"], "mount")
        self.assertEqual(row["anchorChecks"], [{"retryCount": 0, "root": "inconsistent", "usr": "root_ext4"}])
        self.assertEqual(self.sleeps, [])

    def test_same_inode_late_bind_is_refused_at_the_named_reopen(self):
        for path in ("/", "/usr", "/usr/local"):
            with self.subTest(path=path):
                self.attempts, self.sleeps = 0, []
                self.app.mounts = self.mounts = mounts.NativeMounts(self.root, split="/usr")
                changed = []
                def opening(absolute, count, attempt):
                    if absolute == self.root / path.lstrip("/") and count == 2:
                        changed.append(True)
                        if path in self.mounts.entries:
                            self.mounts.replace(path)
                        else:
                            self.mounts.add(path)
                self.refusal(opening)
                self.assertEqual(changed, [True])
                self.assertEqual(self.history()[-1]["terminalCheck"], "mount")
                self.assertEqual(self.sleeps, [])

    def test_diagnostic_exception_and_post_io_deadline_release_outer_anchors(self):
        for failure in (OSError("fixture diagnostic"), b.Failure("process_signal"), b.Failure("timeout")):
            with self.subTest(failure=type(failure).__name__):
                def failing(): raise failure
                result, error = self.observe(on_log=failing)
                self.assertIs(error, failure)
                self.assertIsNone(result)
        self.attempts, self.sleeps = 0, []
        def slow_log(): self.clock += 0.6
        result, error = self.observe(self.churn_at("usr/local"), on_log=slow_log)
        self.assertIsNone(result)
        self.assertIsInstance(error, b.Failure)
        self.assertEqual(error.checks, ["base_compatibility"])
        self.assertEqual(self.live_at_log[-1], ("/", "/usr"))

    def test_actual_command_signal_handlers_release_anchors_on_all_phases(self):
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
            for point in ("acquisition", "backoff", "diagnostic"):
                with self.subTest(signal=sig.name, point=point):
                    self.attempts, self.sleeps = 0, []
                    fired = []
                    def send():
                        if not fired:
                            self.assertEqual(len(self.mounts.fds), 2)
                            if point != "acquisition":
                                self.assertEqual(set(map(self.mounts.logical, self.mounts.fds)), {"/", "/usr"})
                            fired.append(True)
                            os.kill(os.getpid(), sig)
                    churn = self.churn_at("usr/local")
                    def opening(path, number, attempt):
                        churn(path, number, attempt)
                        if point == "acquisition" and path == self.root / "usr" and number == 1:
                            send()
                    result, error = self.observe(opening,
                        on_sleep=lambda _: send() if point == "backoff" else None,
                        on_log=lambda: send() if point == "diagnostic" else None, via_main=True)
                    self.assertIsNone(error)
                    self.assertEqual(fired, [True])
                    self.assertEqual(result, 124 if sig == signal.SIGALRM else 128 + sig)


class NativeObservationSchemaTests(unittest.TestCase):
    def value(self, outcome="stable", retry=0, terminal="none", comparisons=(), anchors=None):
        return {"schema": "zeros.optional-systemd-observation/v2", "callKind": "verification", "outcome": outcome,
                "retryCount": retry, "terminalCheck": terminal, "comparisons": list(comparisons),
                "anchorChecks": ([{"retryCount": i, "root": "native_ext4", "usr": "split_ext4"} for i in range(retry + 1)]
                                 if anchors is None else anchors)}

    def comparison(self, retry=0):
        return {"ancestorIndex": 2, "phase": "open", "retryCount": retry, "failedFields": ["mtime"],
                "mountCheck": "equal", "mountReference": "usr"}

    def rejected(self, value):
        with self.assertRaises(b.Failure):
            b.closed_optional_systemd_observation(value)

    def test_supported_versions_keep_distinct_exact_fields(self):
        for value in (self.value(), self.value("recovered", 2, comparisons=[self.comparison(), self.comparison(1)]),
                      self.value("refused", terminal="policy", anchors=[])):
            self.assertEqual(b.closed_optional_systemd_observation(value), value)
        self.rejected(dict(self.value(), schema="zeros.optional-systemd-observation/v1"))
        self.rejected(dict(self.value(), schema="zeros.optional-systemd-observation/v3"))
        self.rejected(dict(self.value(), schema="zeros.optional-systemd-observation/v2-extra"))

    def test_success_requires_positive_native_anchors_for_every_attempt(self):
        value = self.value("recovered", 1, comparisons=[self.comparison()])
        for index in (0, 1):
            for key in ("root", "usr"):
                for status in ("unobserved", "non_native", "unavailable", "inconsistent"):
                    changed = copy.deepcopy(value)
                    changed["anchorChecks"][index][key] = status
                    self.rejected(changed)

    def test_shared_to_split_in_one_recovered_call_is_impossible(self):
        value = self.value("recovered", 1, comparisons=[self.comparison()])
        value["anchorChecks"][0]["usr"] = "root_ext4"
        self.rejected(value)

    def test_split_to_shared_in_one_recovered_call_is_impossible(self):
        value = self.value("recovered", 1, comparisons=[self.comparison()])
        value["anchorChecks"][1]["usr"] = "root_ext4"
        self.rejected(value)

    def test_unchanged_shared_or_split_anchors_remain_valid_for_all_attempts(self):
        for classification in ("root_ext4", "split_ext4"):
            for retry in range(3):
                value = self.value("recovered" if retry else "stable", retry,
                                   comparisons=[self.comparison(i) for i in range(retry)])
                for row in value["anchorChecks"]:
                    row["usr"] = classification
                self.assertEqual(b.closed_optional_systemd_observation(value), value)

    def test_pre_anchor_mount_refusal_is_closed_without_a_fabricated_comparison(self):
        for key in ("root", "usr"):
            for status in ("non_native", "unavailable", "inconsistent"):
                row = {"retryCount": 0, "root": "native_ext4", "usr": "unobserved"}
                row[key] = status
                value = self.value("refused", terminal="mount", anchors=[row])
                self.assertEqual(b.closed_optional_systemd_observation(value), value)
                self.rejected(dict(value, terminalCheck="policy"))
        self.rejected(self.value("refused", terminal="mount"))
        self.rejected(self.value("refused", terminal="mount", anchors=[]))

    def test_late_anchor_failure_after_contention_is_not_recovery(self):
        value = self.value("refused", 1, "mount", [self.comparison()])
        value["anchorChecks"][1]["root"] = "inconsistent"
        self.assertEqual(b.closed_optional_systemd_observation(value), value)
        self.rejected(dict(value, outcome="recovered", terminalCheck="none"))
        self.rejected(dict(value, terminalCheck="identity"))

    def test_mount_references_are_fixed_and_cannot_expose_values(self):
        value = self.value("recovered", 1, comparisons=[self.comparison()])
        for reference in ("root", "provider", "/usr", 1, None):
            changed = copy.deepcopy(value)
            changed["comparisons"][0]["mountReference"] = reference
            self.rejected(changed)
        self.rejected(dict(value, comparisons=[{**self.comparison(), "id": 101}]))

    def test_anchor_counts_order_duplicates_types_and_unknown_statuses_refuse(self):
        value = self.value()
        row = value["anchorChecks"][0]
        for rows in ([], [row, row], [dict(row, retryCount=1)], [dict(row, retryCount=True)],
                     [dict(row, root="ext4")], [dict(row, usr="native_ext4")],
                     [dict(row, root="unobserved")], [dict(row, device="8:1")]):
            self.rejected(dict(value, anchorChecks=rows))
        self.rejected(dict(value, extra="private-canary"))
        self.rejected(self.value("refused", retry=1, terminal="policy", anchors=[]))


if __name__ == "__main__":
    unittest.main()
