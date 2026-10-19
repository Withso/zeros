"""Closed histories are bounded observations, never current-call authority."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("diagnostic_stability", Path(__file__).with_name("test_optional_systemd_stability.py"))
stability = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stability)
b = stability.b


def comparison(attempt=0, fields=("mtime",), index=2, phase="open", mount="equal"):
    return {"ancestorIndex": index, "phase": phase, "retryCount": attempt,
            "failedFields": list(fields), "mountCheck": mount}


def record(outcome="stable", retry=0, terminal="none", comparisons=()):
    return {"schema": "zeros.optional-systemd-observation/v1", "callKind": "verification", "outcome": outcome,
            "retryCount": retry, "terminalCheck": terminal, "comparisons": list(comparisons)}


class ObservationSchemaTests(unittest.TestCase):
    def validate(self, value):
        self.assertTrue(callable(getattr(b, "closed_optional_systemd_observation", None)), "closed observation validator is required")
        return b.closed_optional_systemd_observation(value)

    def rejected(self, value):
        self.assertTrue(callable(getattr(b, "closed_optional_systemd_observation", None)), "closed observation validator is required")
        with self.assertRaises(b.Failure):
            self.validate(value)

    def test_exact_outcomes_and_bounded_history(self):
        values = [record(), record("recovered", 1, comparisons=[comparison()]),
                  record("recovered", 2, comparisons=[comparison(), comparison(1)]),
                  record("refused", terminal="metadata"),
                  record("refused", 1, "policy", [comparison()]),
                  record("deadline", 0, "deadline", [comparison()]),
                  record("deadline", 1, "deadline", [comparison()]),
                  record("attempt_limit", 2, "attempt_limit", [comparison(i) for i in range(3)])]
        for value in values:
            with self.subTest(outcome=value["outcome"], attempts=value["retryCount"]):
                closed = self.validate(value)
                self.assertEqual(closed, value)
                self.assertIsNot(closed, value)

    def test_recovered_cannot_contain_structural_or_unmeasured_evidence(self):
        for field in ("dev", "ino", "mode", "uid", "gid", "mount_id"):
            row = comparison(fields=(field,), mount="different" if field == "mount_id" else "equal")
            self.rejected(record("recovered", 1, comparisons=[row]))
        for mount in ("not_checked", "unavailable", "different"):
            self.rejected(record("recovered", 1, comparisons=[comparison(mount=mount)]))
        for index in (0, 1, 4, 5, 6):
            self.rejected(record("recovered", 1, comparisons=[comparison(index=index)]))

    def test_recovered_covers_every_discarded_attempt_and_never_final_pass(self):
        for rows in ([], [comparison(1)], [comparison(0), comparison(2)], [comparison(0)]):
            self.rejected(record("recovered", 2, comparisons=rows))
        self.rejected(record("recovered", 0, comparisons=[comparison()]))

    def test_canonical_outcome_terminal_and_deadline_cap_combinations(self):
        for outcome, terminal in (("stable", "deadline"), ("recovered", "identity"), ("refused", "none"),
                                  ("refused", "deadline"), ("refused", "attempt_limit"),
                                  ("deadline", "attempt_limit"), ("attempt_limit", "deadline")):
            self.rejected(record(outcome, 1, terminal, [comparison()]))
        self.rejected(record("deadline", 0, "deadline"))
        self.rejected(record("attempt_limit", 1, "attempt_limit", [comparison()]))
        self.rejected(record("attempt_limit", 2, "attempt_limit", [comparison(), comparison(1)]))

    def test_duplicates_order_types_unknown_fields_and_limits_refuse(self):
        value = record("recovered", 1, comparisons=[comparison()])
        candidates = [dict(value, unexpected="private-value-canary"), dict(value, callKind="private-kind-canary"),
                      dict(value, retryCount=True), dict(value, retryCount=1.0), dict(value, retryCount=3),
                      dict(value, schema="zeros.optional-systemd-observation/v2"), dict(value, comparisons=[comparison()] * 7),
                      dict(value, comparisons=[comparison(), comparison()]),
                      dict(value, comparisons=[comparison(fields=("ctime", "mtime"))]),
                      dict(value, comparisons=[comparison(fields=("mtime", "mtime"))]),
                      dict(value, comparisons=[dict(comparison(), ancestorIndex=True)]),
                      dict(value, comparisons=[dict(comparison(), phase="private-phase-canary")]),
                      dict(value, comparisons=[dict(comparison(), extra="private-field-canary")])]
        for candidate in candidates:
            with self.subTest(keys=list(candidate)):
                self.rejected(candidate)

    def test_measured_mount_difference_is_distinct_from_unreadable_or_unperformed(self):
        for mount, fields in (("different", ("mount_id",)), ("unavailable", ()), ("not_checked", ("ino",))):
            value = record("refused", 0, "mount" if mount != "not_checked" else "identity", [comparison(fields=fields, mount=mount)])
            self.assertEqual(self.validate(value), value)
        for mount, fields in (("equal", ("mount_id",)), ("different", ()), ("not_checked", ()), ("equal", ())):
            self.rejected(record("refused", terminal="mount", comparisons=[comparison(fields=fields, mount=mount)]))

    def test_fixed_ancestor_indexes_and_phases_allow_only_closed_integers_and_enums(self):
        for index in range(7):
            for phase in ("open", "original", "named", "reopened"):
                value = record("refused", terminal="identity", comparisons=[comparison(fields=("ino",), index=index, phase=phase, mount="not_checked")])
                self.assertEqual(self.validate(value), value)
        for index in (-1, 7, 1.0, True):
            self.rejected(record("refused", terminal="identity", comparisons=[comparison(index=index)]))


class ObservationSourceTests(stability.StabilityFixture):
    def stat_change(self, value, **changes):
        fields = {key: getattr(value, key) for key in dir(value) if key.startswith("st_")}
        return types.SimpleNamespace(**dict(fields, **changes))

    def test_each_identity_operand_is_reported_from_the_captured_comparison(self):
        for field, attribute in (("dev", "st_dev"), ("ino", "st_ino"), ("mode", "st_mode"), ("uid", "st_uid"),
                                 ("gid", "st_gid"), ("mtime", "st_mtime_ns"), ("ctime", "st_ctime_ns")):
            with self.subTest(field=field):
                self.attempts, self.sleeps = 0, []
                original = b.os.stat
                fired = False
                def changed(name, *args, **kwargs):
                    nonlocal fired
                    value = original(name, *args, **kwargs)
                    if not fired and self.absolute(name, kwargs) == self.fixture.local:
                        fired = True
                        values = {key: getattr(value, key) for key in dir(value) if key.startswith("st_")}
                        values[attribute] = {"mode": 0o40555, "uid": self.app.uid, "gid": self.app.gid}.get(field, values[attribute] + 1)
                        return types.SimpleNamespace(**values)
                    return value
                with mock.patch.object(b.os, "stat", side_effect=changed):
                    self.observe()
                self.assertTrue(fired)
                self.assertTrue(self.history(), "actual compound-guard operands need closed history")
                row = self.history()[-1]["comparisons"][0]
                self.assertEqual((row["ancestorIndex"], row["phase"], row["failedFields"]), (2, "open", [field]))

    def test_all_differing_operands_are_retained_together(self):
        original, mount_id = b.os.stat, self.app.mounts.mount_id
        fired = False
        def changed(name, *args, **kwargs):
            nonlocal fired
            value = original(name, *args, **kwargs)
            if not fired and self.absolute(name, kwargs) == self.fixture.local:
                fired = True
                return self.stat_change(value, st_dev=value.st_dev + 1, st_ino=value.st_ino + 1,
                                        st_mode=0o40555, st_uid=self.app.uid, st_gid=self.app.gid,
                                        st_mtime_ns=value.st_mtime_ns + 1, st_ctime_ns=value.st_ctime_ns + 1)
            return value
        def mounted(fd):
            return mount_id(fd) + int(Path(os.readlink(f"/proc/self/fd/{fd}")) == self.fixture.local)
        with mock.patch.object(b.os, "stat", side_effect=changed), mock.patch.object(self.app.mounts, "mount_id", side_effect=mounted):
            self.refusal(lambda *_: None)
        row = self.history()[-1]["comparisons"][0]
        self.assertEqual(row["failedFields"], ["dev", "ino", "mode", "uid", "gid", "mtime", "ctime", "mount_id"])
        self.assertEqual(row["mountCheck"], "different")

    def test_original_named_and_reopened_comparisons_keep_the_actual_phase(self):
        for phase in ("original", "named", "reopened"):
            with self.subTest(phase=phase):
                self.attempts, self.sleeps = 0, []
                original_stat, original_fstat = b.os.stat, b.os.fstat
                counts = {"named": 0, "fd": 0}
                def named(name, *args, **kwargs):
                    value = original_stat(name, *args, **kwargs)
                    if self.absolute(name, kwargs) == self.fixture.local:
                        counts["named"] += 1
                        if phase == "named" and counts["named"] == 2:
                            return self.stat_change(value, st_ino=value.st_ino + 1)
                    return value
                def descriptor(fd):
                    value = original_fstat(fd)
                    if Path(os.readlink(f"/proc/self/fd/{fd}")) == self.fixture.local:
                        counts["fd"] += 1
                        if (phase, counts["fd"]) in (("original", 2), ("reopened", 4)):
                            return self.stat_change(value, st_ino=value.st_ino + 1)
                    return value
                with mock.patch.object(b.os, "stat", side_effect=named), mock.patch.object(b.os, "fstat", side_effect=descriptor):
                    self.refusal(lambda *_: None)
                row = self.history()[-1]["comparisons"][-1]
                self.assertEqual((row["phase"], row["failedFields"]), (phase, ["ino"]))

    def test_source_indexes_are_fixed_and_recursive_names_are_not_emitted(self):
        (self.fixture.local / "lib/systemd/system/private-name-canary").mkdir(parents=True)
        self.policy = self.fixture.qualify()
        paths = (self.root, self.root / "usr", self.fixture.local, self.fixture.local / "lib",
                 self.fixture.local / "lib/systemd", self.fixture.local / "lib/systemd/system",
                 self.fixture.local / "lib/systemd/system/private-name-canary")
        for index, target in enumerate(paths):
            with self.subTest(index=index):
                self.attempts, self.sleeps = 0, []
                original_stat, original_fstat = b.os.stat, b.os.fstat
                reads, fired = 0, False
                def changed(name, *args, **kwargs):
                    nonlocal fired
                    value = original_stat(name, *args, **kwargs)
                    if index and not fired and self.absolute(name, kwargs) == target:
                        fired = True
                        return self.stat_change(value, st_ino=value.st_ino + 1)
                    return value
                def descriptor(fd):
                    nonlocal reads, fired
                    value = original_fstat(fd)
                    if not index and Path(os.readlink(f"/proc/self/fd/{fd}")) == target:
                        reads += 1
                        if reads == 2:
                            fired = True
                            return self.stat_change(value, st_ino=value.st_ino + 1)
                    return value
                with mock.patch.object(b.os, "stat", side_effect=changed), mock.patch.object(b.os, "fstat", side_effect=descriptor):
                    self.refusal(lambda *_: None)
                self.assertTrue(fired)
                row = self.history()[-1]["comparisons"][-1]
                self.assertEqual((row["ancestorIndex"], row["failedFields"]), (index, ["ino"]))
                self.assertNotIn("private-name-canary", json.dumps(self.history()))

    def test_mount_difference_and_unavailable_read_do_not_become_equality(self):
        original = self.app.mounts.mount_id
        for unavailable in (False, True):
            with self.subTest(unavailable=unavailable):
                self.attempts, self.sleeps = 0, []
                def mounted(fd):
                    value = original(fd)
                    if Path(os.readlink(f"/proc/self/fd/{fd}")) == self.fixture.local:
                        if unavailable:
                            raise OSError("private-mount-canary")
                        return value + 1
                    return value
                with mock.patch.object(self.app.mounts, "mount_id", side_effect=mounted):
                    self.refusal(lambda *_: None)
                self.assertEqual(self.attempts, 1)
                self.assertTrue(self.history(), "mount refusal needs measured-versus-unavailable evidence")
                row = self.history()[-1]["comparisons"][0]
                self.assertEqual(row["mountCheck"], "unavailable" if unavailable else "different")
                self.assertEqual(row["failedFields"], [] if unavailable else ["mount_id"])

    def test_equal_records_from_independent_calls_remain_distinct(self):
        self.fixture.verify(self.policy)
        self.fixture.verify(self.policy)
        rows = self.history()
        self.assertGreaterEqual(len(rows), 3)
        expected = {**record(), "schema": "zeros.optional-systemd-observation/v2",
                    "anchorChecks": [{"retryCount": 0, "root": "native_ext4", "usr": "root_ext4"}]}
        self.assertEqual(rows[-2:], [expected, expected])

    def test_log_lock_failure_leaves_indistinguishable_old_history_without_affecting_admission(self):
        path = self.root / "run/zeros/optional-systemd-observations.jsonl"
        self.assertTrue(path.exists(), "initial qualification must emit a best-effort record")
        before = path.read_bytes()
        results = []
        with self.app.lock("diagnostic.lock"):
            results.append(self.observe()[0])
            self.attempts, self.sleeps = 0, []
            results.append(self.observe(self.churn_at("usr/local"))[0])
        self.assertEqual(results, [self.policy["snapshot"], self.policy["snapshot"]])
        self.assertEqual(path.read_bytes(), before, "valid old history cannot reveal which current call lost its write")

    def test_diagnostic_failures_do_not_mask_a_stronger_refusal_or_leak_values(self):
        def writing(*_args, **_kwargs):
            raise OSError("private-log-canary")
        with mock.patch.object(self.app, "atomic", side_effect=writing):
            result, error = self.observe()
            self.assertIsNone(error)
            self.assertEqual(result, self.policy["snapshot"])
            self.attempts, self.sleeps = 0, []
            self.refusal(lambda path, number, attempt: path.chmod(0o777) if path == self.fixture.local and number == 2 else None)
        self.assertNotIn("private-log-canary", json.dumps(self.history()))

    def test_alias_and_multiple_links_are_never_overwritten_by_observation_logging(self):
        path = self.root / "run/zeros/optional-systemd-observations.jsonl"
        self.assertTrue(path.exists(), "initial diagnostic log missing")
        target = self.root / "private-target"
        target.write_bytes(b"private-body-canary")
        path.unlink()
        path.symlink_to(target)
        self.fixture.verify(self.policy)
        self.assertTrue(path.is_symlink())
        self.assertEqual(target.read_bytes(), b"private-body-canary")
        path.unlink()
        path.write_bytes(b"private-body-canary")
        path.chmod(0o600)
        twin = path.with_name("twin")
        os.link(path, twin)
        self.fixture.verify(self.policy)
        self.assertEqual(path.read_bytes(), b"private-body-canary")
        self.assertEqual(path.stat().st_ino, twin.stat().st_ino)

    def test_log_is_private_bounded_and_rotates_complete_lines(self):
        path = self.root / "run/zeros/optional-systemd-observations.jsonl"
        self.assertTrue(path.exists(), "initial diagnostic log missing")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        line = (json.dumps(record(), separators=(",", ":")) + "\n").encode()
        path.write_bytes(line * (65536 // len(line)))
        self.fixture.verify(self.policy)
        raw = path.read_bytes()
        self.assertLessEqual(len(raw), 65536)
        self.assertTrue(raw.endswith(b"\n"))
        self.assertTrue(all(json.loads(line)["schema"] in ("zeros.optional-systemd-observation/v1", "zeros.optional-systemd-observation/v2")
                            for line in raw.splitlines()))
        self.assertEqual(json.loads(raw.splitlines()[-1])["schema"], "zeros.optional-systemd-observation/v2")
        self.assertNotIn(str(self.root).encode(), raw)


if __name__ == "__main__":
    unittest.main()
