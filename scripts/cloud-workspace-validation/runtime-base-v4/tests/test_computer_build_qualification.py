import copy
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("computer_build_qualification", SOURCE / "computer-build-qualification.py")
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class Records(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.addCleanup(self.scratch.cleanup)
        self.uid, self.gid = os.getuid(), os.getgid()
        self.store = qualification.QualificationStore(self.root, uid=self.uid, gid=self.gid)
        self.evidence = json.loads((SOURCE.parents[2] / "packages/protocol/src/__tests__/fixtures/cloud-build-qualification.valid.json").read_text())
        self.build_id = self.evidence["scope"]["buildId"]
        self.integrity = {"schema": "zeros.computer-boot-integrity/v1", "fixture": True}
        self.report = {"schema": "zeros.computer-self-test/v1", "fixture": True}
        self.evidence["base"]["bootIntegritySha256"] = qualification.digest(self.integrity)
        self.evidence["reportSha256"] = qualification.digest(self.report)
        self.values = {"integrity.json": self.integrity, "evidence.json": self.evidence, "report.json": self.report}
        self.directory = self.root / "srv/zeros/runtime-installs/build-qualifications" / self.build_id

    def publish(self):
        self.store.publish(self.build_id, self.values)

    def read(self):
        return self.store.read(self.build_id, qualification.digest(self.evidence))

    def test_original_canonical_bytes_are_immutable_and_private(self):
        self.publish()
        self.assertEqual(self.read(), self.values)
        self.assertEqual(self.directory.stat().st_mode & 0o7777, 0o700)
        self.assertEqual(self.directory.parent.stat().st_mode & 0o7777, 0o700)
        originals = {}
        for name, value in self.values.items():
            target = self.directory / name
            self.assertEqual(target.read_bytes(), qualification.packed(value))
            self.assertEqual(target.stat().st_mode & 0o7777, 0o444)
            self.assertEqual((target.stat().st_uid, target.stat().st_gid, target.stat().st_nlink), (self.uid, self.gid, 1))
            originals[name] = target.stat().st_ino
        self.publish()
        self.assertEqual({name: (self.directory / name).stat().st_ino for name in self.values}, originals)

    def test_another_build_or_external_digest_cannot_select_the_record(self):
        self.publish()
        with self.assertRaises(qualification.Failure): self.store.read(self.build_id, "0" * 64)
        with self.assertRaises(qualification.Failure): self.store.read("11111111-1111-4111-8111-111111111111", qualification.digest(self.evidence))
        for bad in ("../other", self.build_id + "/../other", "", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"):
            with self.subTest(build=bad):
                with self.assertRaises(qualification.Failure): self.store.read(bad, qualification.digest(self.evidence))

    def test_partial_directory_is_not_repaired_or_overwritten(self):
        self.directory.mkdir(parents=True, mode=0o700)
        self.directory.parent.chmod(0o700)
        file = self.directory / "integrity.json"
        file.write_bytes(b"partial original")
        file.chmod(0o444)
        with self.assertRaises(qualification.Failure): self.publish()
        self.assertEqual(file.read_bytes(), b"partial original")
        self.assertEqual(sorted(os.listdir(self.directory)), ["integrity.json"])

    def test_republication_of_different_evidence_cannot_change_the_first_record(self):
        self.publish()
        original = (self.directory / "evidence.json").read_bytes()
        self.evidence["builder"]["workerFence"] += 1
        with self.assertRaises(qualification.Failure): self.publish()
        self.assertEqual((self.directory / "evidence.json").read_bytes(), original)

    def test_alias_hardlink_and_permissive_metadata_refuse_without_writing_target(self):
        self.publish()
        for alteration in ("symlink", "hardlink", "writable", "directory-mode"):
            with self.subTest(alteration=alteration):
                target = self.directory / "evidence.json"
                original = target.read_bytes()
                outside = self.root / "untouched"
                outside.write_bytes(original)
                outside.chmod(0o444)
                if alteration == "symlink":
                    target.unlink()
                    target.symlink_to(outside)
                elif alteration == "hardlink":
                    target.unlink()
                    os.link(outside, target)
                elif alteration == "writable": target.chmod(0o644)
                else: self.directory.chmod(0o755)
                with self.assertRaises(qualification.Failure): self.read()
                with self.assertRaises(qualification.Failure): self.publish()
                self.assertEqual(outside.read_bytes(), original)
                if alteration != "directory-mode":
                    target.unlink()
                    target.write_bytes(original)
                    target.chmod(0o444)
                self.directory.chmod(0o700)
                outside.unlink()

    def test_duplicate_keys_noncanonical_bytes_wrong_linked_digest_and_extra_files_refuse(self):
        self.publish()
        target = self.directory / "evidence.json"
        original = target.read_bytes()
        for raw in (b'{"schema":0,"schema":1}', original + b"\n", original.replace(b'"scope":', b'"unexpected":')):
            target.chmod(0o600)
            target.write_bytes(raw)
            target.chmod(0o444)
            with self.assertRaises(qualification.Failure): self.read()
        target.chmod(0o600)
        target.write_bytes(original)
        target.chmod(0o444)
        integrity = self.directory / "integrity.json"
        integrity.chmod(0o600)
        integrity.write_bytes(b"{}")
        integrity.chmod(0o444)
        with self.assertRaises(qualification.Failure): self.read()

    def test_overflow_and_unknown_file_names_refuse_before_creating_a_record(self):
        for values in ({**self.values, "../outside": {}}, {**self.values, "integrity.json": {"oversize": "x" * qualification.LIMITS["integrity.json"]}},
                       {**self.values, "evidence.json": {"oversize": "x" * (64 * 1024)}}):
            with self.subTest(keys=list(values)):
                with self.assertRaises(qualification.Failure): self.store.publish(self.build_id, values)
                self.assertFalse(self.directory.exists())

    def test_replaced_ancestry_after_io_cannot_return_or_rewrite_the_replacement(self):
        self.publish()
        original_read = qualification.os.read
        swapped = False
        def read(fd, size):
            nonlocal swapped
            raw = original_read(fd, size)
            if not swapped:
                swapped = True
                self.directory.rename(self.directory.with_name("original"))
                self.directory.mkdir(mode=0o700)
                (self.directory / "replacement").write_bytes(b"keep")
            return raw
        with patch.object(qualification.os, "read", side_effect=read):
            with self.assertRaises(qualification.Failure): self.read()
        self.assertEqual((self.directory / "replacement").read_bytes(), b"keep")

    def change_original_integrity(self, *, replace):
        target = self.directory / "integrity.json"
        before = target.stat()
        raw = qualification.packed({**self.integrity, "fixture": False})
        if replace:
            successor = self.directory / "successor"
            successor.write_bytes(raw)
            successor.chmod(0o444)
            os.replace(successor, target)
        else:
            target.chmod(0o600)
            target.write_bytes(raw)
            target.chmod(0o444)
            # Restoring mtime and the original mode cannot hide a changed inode.
            os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
        return raw

    def require_original_file_fence(self, *, replace):
        self.publish()
        original_read = qualification.os.read
        last_inode = (self.directory / "report.json").stat().st_ino
        changed = []

        def read(fd, size):
            raw = original_read(fd, size)
            if raw and os.fstat(fd).st_ino == last_inode and not changed:
                changed.append(self.change_original_integrity(replace=replace))
            return raw

        with patch.object(qualification.os, "read", side_effect=read):
            with self.assertRaises(qualification.Failure): self.read()
        self.assertEqual(len(changed), 1, "the mutation must cross an already completed file read")
        self.assertEqual((self.directory / "integrity.json").read_bytes(), changed[0])

    def test_original_file_replacement_during_a_later_read_cannot_return_stale_evidence(self):
        self.require_original_file_fence(replace=True)

    def test_original_file_rewrite_during_a_later_read_cannot_return_stale_evidence(self):
        self.require_original_file_fence(replace=False)

    def test_original_files_remain_fenced_through_external_digest_validation(self):
        self.publish()
        validate = qualification.validate_bundle
        changed = []

        def validate_then_change(build_id, values):
            validate(build_id, values)
            changed.append(self.change_original_integrity(replace=True))

        with patch.object(qualification, "validate_bundle", side_effect=validate_then_change):
            with self.assertRaises(qualification.Failure): self.read()
        self.assertEqual(len(changed), 1)
        self.assertEqual((self.directory / "integrity.json").read_bytes(), changed[0])


class Producer(unittest.TestCase):
    # The storage tests above use real private files. These controls inject
    # guest probes only, so failure timing is deterministic without a live VM.
    def setUp(self):
        Records.setUp(self)
        self.trace = []
        self.now = qualification.timestamp(self.evidence["qualifiedAt"])
        self.request = {
            "schema": "zeros.computer-build-qualification-input/v1", "buildId": self.build_id,
            "workerFence": 1, "producerFence": 1, "scope": self.evidence["scope"],
            "builder": {key: self.evidence["builder"][key] for key in ("operationKey", "sandboxId")},
            "runtime": {key: self.evidence["runtime"][key] for key in ("runtimeId", "manifestSha256", "archiveSha256", "engineProtocolVersion")},
            "base": {key: self.evidence["base"][key] for key in ("baseImageId", "baseCompatibilityId", "compatibilitySha256", "sourceCommit", "architecture")},
            "protectedContractSha256": self.evidence["base"]["protectedContractSha256"],
            "sanitationManifestSha256": self.evidence["sanitationManifestSha256"],
            "deadlineAt": "2026-01-01T00:05:00.000Z",
        }
        self.template = {"schema": "zeros.computer-template/v1", "buildId": self.build_id,
            "configId": self.request["scope"]["configId"], "baseImageId": self.request["base"]["baseImageId"],
            "baseCompatibilityId": self.request["base"]["baseCompatibilityId"], "runtimeId": self.request["runtime"]["runtimeId"],
            "protectedContractDigest": self.request["protectedContractSha256"], "repositoryManifest": []}
        self.request["sanitationManifestSha256"] = qualification.digest(self.template)
        self.report = json.loads((SOURCE.parents[1] / "__tests__/fixtures/cloud-computer-self-test.valid.json").read_text())
        self.receipt = qualification.packed({"archiveSha256": self.request["runtime"]["archiveSha256"], "fixture": True})
        self.report["runtime"]["installerReceiptSha256"] = hashlib.sha256(self.receipt).hexdigest()
        self.root_runtime = "/opt/zeros-infra/" + self.request["runtime"]["runtimeId"]
        self.offer = qualification.packed({"schema": "zeros.build-qualification-support/v1", "version": 1})
        self.manifest = {"protocols": {"engine": self.request["runtime"]["engineProtocolVersion"]}, "files": [
            {"path": "lib/zeros/build-qualification-support.json", "type": "file", "mode": "0444", "sha256": hashlib.sha256(self.offer).hexdigest()},
            {"path": "lib/zeros/cloud-resource-admission.mjs", "type": "file", "mode": "0555", "sha256": self.report["policy"]["resourcePolicySha256"]},
        ]}
        self.active = {"schema": "zeros.active-runtime/v1", "root": self.root_runtime,
                       "cgroupRoot": "/sys/fs/cgroup/system.slice/zeros-host.service", **self.report["runtime"]}
        self.app = types.SimpleNamespace(root=self.root, uid=self.uid, gid=self.gid,
            compat={"buildQualificationVersion": 1}, compat_id=self.request["base"]["baseCompatibilityId"],
            base=lambda: self.trace.append("base"), require_persistence=lambda: self.trace.append("persistence"),
            current=lambda: self.request["runtime"]["runtimeId"], boot_id=lambda: self.active["bootId"],
            verify_runtime=self.full_runtime, read=self.app_read, lock=self.lock)
        self.kernel = {"kernel": self.evidence["kernel"], "features": {"schema": "zeros.kernel-feature-policy/v1", "fixture": True}}
        self.closure = {"schema": "zeros.computer-protected-closure/v1", "policyVersion": 1, "systemdPaths": [],
                        "inventory": {"schema": "zeros.computer-boot-integrity-inventory/v1", "selectors": [], "entries": {}}}
        self.kernel_read = self.add_mock("running_kernel_identity", lambda: copy.deepcopy(self.kernel))
        self.add_mock("capture_protected_closure", lambda *_args, **_kwargs: copy.deepcopy(self.closure))
        self.add_mock("discover_loader_dependencies", lambda *_args, **_kwargs: [])
        self.closure_check = self.add_mock("verify_protected_closure", lambda *_args, **_kwargs: self.trace.append("closure"))

    def add_mock(self, name, side_effect):
        patcher = patch.object(qualification.integrity, name, side_effect=side_effect)
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    @contextlib.contextmanager
    def lock(self, name):
        self.trace.append("lock:" + name)
        try: yield
        finally: self.trace.append("unlock:" + name)

    def full_runtime(self, runtime_id, *, full):
        self.assertTrue(full)
        self.assertEqual(runtime_id, self.request["runtime"]["runtimeId"])
        self.trace.append("full-runtime")
        return self.manifest, self.receipt

    def app_read(self, name, *_args):
        if name == "/run/zeros/active-runtime.json": return qualification.packed(self.active)
        if name == "/etc/zeros/base-build.json": return qualification.packed({"schema": "zeros.base-build/v1", "sourceCommit": self.request["base"]["sourceCommit"],
            "profile": "zeros-cloud-worker-v4", "sourceSha256": "a" * 64, "baseCompatibilityId": self.app.compat_id})
        if name == "/opt/zeros-bootstrap/stock-prerequisites.json": return b"{}"
        if name == "/srv/zeros/computer-template.json": return qualification.packed(self.template)
        if name == "/srv/zeros/runtime-installs/" + self.request["runtime"]["runtimeId"] + ".json": return self.receipt
        if name == self.root_runtime + "/lib/zeros/build-qualification-support.json": return self.offer
        raise AssertionError("unexpected fixed read")

    def command(self, args, **_kwargs):
        self.assertEqual(args, [str(self.root / self.root_runtime.lstrip("/") / "bin/node"),
            str(self.root / self.root_runtime.lstrip("/") / "lib/zeros/runtime-self-test.mjs"), "--build-qualification"])
        self.trace.append("full-probe")
        diagnostic = {"schema": "zeros.diagnostic/v1", "component": "qualification", "stage": "self_test", "ok": True,
                      "exitCode": 0, "timedOut": False, "failedChecks": []}
        return 0, qualification.packed(self.report) + b"\n" + qualification.packed(diagnostic) + b"\n"

    def produce(self, **kwargs):
        return qualification.produce_build(self.app, self.request, verify_tcb=lambda: self.trace.append("tcb"),
            command=kwargs.get("command", self.command), now=lambda: self.now)

    def test_complete_fixed_probe_records_exact_original_scope_after_full_byte_checks(self):
        result = self.produce()
        self.assertEqual(result["mode"], "build")
        proof = result["evidence"]
        self.assertEqual(proof["scope"], self.request["scope"])
        self.assertEqual(proof["builder"], {**self.request["builder"], "helperFence": 1, "workerFence": 1, "bootId": self.active["bootId"]})
        self.assertLess(self.trace.index("full-runtime"), self.trace.index("full-probe"))
        self.assertLess(self.trace.index("full-probe"), len(self.trace) - 1 - self.trace[::-1].index("full-runtime"))
        self.assertEqual(self.trace.count("full-probe"), 1)
        self.assertEqual(self.trace[-2:], ["unlock:runtime-publication.lock", "unlock:runtime-install.lock"])
        recorded = self.store.read(self.build_id, qualification.digest(proof))
        self.assertEqual(recorded["report.json"], self.report)
        self.assertNotIn("bootId", qualification.packed(recorded["integrity.json"]).decode())

    def test_absent_runtime_offer_preserves_full_mode_without_producing_evidence(self):
        self.manifest["files"].pop(0)
        self.assertEqual(self.produce(), {"schema": "zeros.computer-build-producer/v1", "mode": "full"})
        self.assertNotIn("full-probe", self.trace)
        self.assertFalse(self.directory.exists())

    def test_malformed_present_offer_never_falls_back_to_full(self):
        self.offer = b'{"schema":"zeros.build-qualification-support/v1","version":2}'
        self.manifest["files"][0]["sha256"] = hashlib.sha256(self.offer).hexdigest()
        with self.assertRaises(qualification.Failure): self.produce()
        self.assertNotIn("full-probe", self.trace)
        self.assertFalse(self.directory.exists())

    def test_missing_result_false_result_wrong_policy_and_unbounded_output_cannot_publish(self):
        original = copy.deepcopy(self.report)
        for kind in ("missing", "false", "policy", "foreign-runtime", "foreign-boot", "extra-check"):
            with self.subTest(kind=kind):
                self.report = copy.deepcopy(original)
                if kind == "missing": del self.report["results"]["setupProcess"]
                elif kind == "false": self.report["results"]["retirement"] = False
                elif kind == "policy": self.report["policy"]["sha256"] = "0" * 64
                elif kind == "foreign-runtime": self.report["runtime"]["runtimeId"] = "r1-" + "f" * 64
                elif kind == "foreign-boot": self.report["runtime"]["bootId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                else: self.report["checks"]["identity"].append("untrusted-output")
                with self.assertRaises(qualification.Failure): self.produce()
                self.assertFalse(self.directory.exists())
        self.report = original
        with self.assertRaises(qualification.Failure): self.produce(command=lambda *_args, **_kwargs: (0, b"x" * (65_536 + 1)))

    def test_late_runtime_boot_receipt_kernel_or_deadline_change_refuses_after_probe(self):
        original_active, original_receipt, original_kernel = copy.deepcopy(self.active), self.receipt, copy.deepcopy(self.kernel)
        for changed in ("session", "boot", "receipt", "kernel", "deadline"):
            with self.subTest(changed=changed):
                def command(*args, **kwargs):
                    result = self.command(*args, **kwargs)
                    if changed == "session": self.active["supervisorSessionId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                    elif changed == "boot": self.active["bootId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                    elif changed == "receipt": self.receipt += b" "
                    elif changed == "kernel": self.kernel["kernel"]["buildId"] = "a2" * 20
                    else: self.now += 301
                    return result
                with self.assertRaises(qualification.Failure): self.produce(command=command)
                self.assertFalse(self.directory.exists())
                self.active, self.receipt, self.kernel = copy.deepcopy(original_active), original_receipt, copy.deepcopy(original_kernel)
                self.now = qualification.timestamp(self.evidence["qualifiedAt"])

    def test_unacknowledged_local_result_cannot_be_adopted_by_a_later_worker_or_replay_probes(self):
        self.produce()
        probes = self.trace.count("full-probe")
        self.request["producerFence"] = 2
        with self.assertRaises(qualification.Failure): self.produce()
        self.assertEqual(self.trace.count("full-probe"), probes)

    def test_discovery_commands_share_the_original_deadline_and_stop_after_io(self):
        self.request["deadlineAt"] = "2026-01-01T00:00:05.000Z"
        calls = []
        def command(_args, **kwargs):
            calls.append(kwargs["timeout"])
            self.now += 6
            return 0, b"fixture"
        def discovery(_closure, _runtime, _manifest, bounded, **_kwargs):
            bounded(["/usr/bin/ldd", "/usr/bin/fixture"], timeout=10, limit=65536)
            bounded(["/usr/bin/ldd", "/usr/bin/another"], timeout=10, limit=65536)
            return []
        with patch.object(qualification.integrity, "discover_loader_dependencies", side_effect=discovery):
            with self.assertRaises(qualification.Failure): self.produce(command=command)
        self.assertEqual(len(calls), 1, "an expired discovery must not start another process")
        self.assertLessEqual(calls[0], 5)
        self.assertFalse(self.directory.exists())

    def test_expired_closure_cannot_start_dependency_discovery(self):
        def capture(*_args, **_kwargs):
            self.now += 301
            return copy.deepcopy(self.closure)
        with patch.object(qualification.integrity, "capture_protected_closure", side_effect=capture), \
                patch.object(qualification.integrity, "discover_loader_dependencies", return_value=[]) as discovery:
            with self.assertRaises(qualification.Failure): self.produce()
        discovery.assert_not_called()
        self.assertFalse(self.directory.exists())

    def test_wall_clock_rollback_does_not_restart_the_build_budget(self):
        clock = [10.0]
        def command(*args, **kwargs):
            result = self.command(*args, **kwargs)
            clock[0] += 301
            # Simulate a clock step back to the original wall time after the
            # elapsed budget has expired; the report is still historically valid.
            return result
        with patch.object(qualification.time, "monotonic", side_effect=lambda: clock[0]):
            with self.assertRaises(qualification.Failure): self.produce(command=command)
        self.assertFalse(self.directory.exists())

    def test_selected_closure_is_rechecked_after_final_runtime_io(self):
        selection = self.selection()
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        reads, changed = [], []
        original = self.app.verify_runtime
        def verify(*args, **kwargs):
            result = original(*args, **kwargs)
            reads.append(True)
            if len(reads) == 2: changed.append(True)
            return result
        def closure(*_args, **_kwargs):
            if changed: raise qualification.integrity.Failure()
        self.closure_check.side_effect = closure
        with patch.object(self.app, "verify_runtime", side_effect=verify):
            with self.assertRaises(qualification.Failure): qualification.verify_selected_build(self.app, selection, runtime)
        self.assertTrue(changed)

    def selection(self):
        evidence = self.produce()["evidence"]
        return {"mode": "build", "qualificationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "evidence": evidence,
            "evidenceSha256": qualification.digest(evidence), "snapshot": {"name": "fixture-alpha-computer-v1",
            "snapshotId": "fixture_snapshot", "treeSha256": "f" * 64}}

    def test_selected_verifier_binds_saved_bytes_and_fresh_boot_without_replaying_roles(self):
        selection = self.selection()
        self.active["bootId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        self.active["supervisorSessionId"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        probes = self.trace.count("full-probe")
        result = qualification.verify_selected_build(self.app, selection, runtime)
        self.assertEqual(result, {"schema": "zeros.computer-build-verification/v1", "qualificationId": selection["qualificationId"],
            "evidenceSha256": selection["evidenceSha256"], "bootIntegritySha256": selection["evidence"]["base"]["bootIntegritySha256"],
            "kernelSha256": qualification.digest(selection["evidence"]["kernel"]), "runtime": runtime})
        self.assertEqual(self.trace.count("full-probe"), probes)
        self.assertNotEqual(runtime["bootId"], selection["evidence"]["builder"]["bootId"])

    def test_selected_verifier_never_downgrades_kernel_source_or_snapshot_failure(self):
        selected = self.selection()
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        for changed in ("kernel", "template", "snapshot", "evidence", "runtime"):
            with self.subTest(changed=changed):
                selection, expected = copy.deepcopy(selected), copy.deepcopy(runtime)
                if changed == "kernel": self.kernel["features"]["fixture"] = False
                elif changed == "template": self.template["configId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                elif changed == "snapshot": del selection["snapshot"]
                elif changed == "evidence": selection["evidenceSha256"] = "0" * 64
                else: expected["supervisorSessionId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                with self.assertRaises(qualification.Failure): qualification.verify_selected_build(self.app, selection, expected)
                self.kernel["features"]["fixture"] = True
                self.template["configId"] = self.request["scope"]["configId"]

    def test_selected_verifier_rechecks_original_runtime_after_closure_io(self):
        selection = self.selection()
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        def changed(*_args, **_kwargs): self.active["supervisorSessionId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        self.closure_check.side_effect = changed
        with self.assertRaises(qualification.Failure): qualification.verify_selected_build(self.app, selection, runtime)

    def test_selected_verifier_retains_original_record_fds_through_later_closure_io(self):
        selection = self.selection()
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        self.closure_check.side_effect = lambda *_args, **_kwargs: Records.change_original_integrity(self, replace=True)
        with self.assertRaises(qualification.Failure): qualification.verify_selected_build(self.app, selection, runtime)

    def test_selected_verifier_rechecks_template_after_final_runtime_io(self):
        selection = self.selection()
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        original = self.full_runtime
        calls = 0
        def changed(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2: self.template["configId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            return original(*args, **kwargs)
        self.app.verify_runtime = changed
        with self.assertRaises(qualification.Failure): qualification.verify_selected_build(self.app, selection, runtime)

    def boot_session(self, *, offered=True):
        selection = self.selection()
        raw = qualification.packed({"schema": "zeros.build-boot-support/v1", "version": 1})
        name = "lib/zeros/build-boot-support.json"
        if offered: self.manifest["files"].append({"path": name, "type": "file", "mode": "0444", "sha256": hashlib.sha256(raw).hexdigest()})
        read = self.app.read
        self.app.read = lambda path, *args: raw if path == self.root_runtime + "/" + name else read(path, *args)
        self.clock = 0.0
        self.fence = mock_fence = unittest.mock.Mock()
        session = qualification.BuildVerifierSession(self.app, selection, self.request["runtime"],
            assert_current=mock_fence, monotonic=lambda: self.clock, now=lambda: self.now)
        return session, selection

    def test_installer_session_freezes_selection_and_never_reacquires_install_lock(self):
        session, selection = self.boot_session()
        hello = session.start(2.0, self.now + 2)
        self.trace.clear()
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        result = session.verify({"selection": selection, "runtime": runtime})
        self.assertEqual(result["qualificationId"], selection["qualificationId"])
        self.assertIn("lock:runtime-publication.lock", self.trace)
        self.assertNotIn("lock:runtime-install.lock", self.trace)
        self.assertGreater(self.fence.call_count, 1)
        self.assertEqual(hello["selection"], selection)
        session.finish()

    def test_selected_runtime_requires_the_separate_boot_transport_offer(self):
        session, _ = self.boot_session(offered=False)
        with self.assertRaises(qualification.Failure): session.start(2, self.now + 2)

    def test_session_cannot_change_selection_restart_budget_or_accept_late_io(self):
        session, selection = self.boot_session()
        session.start(2, self.now + 2)
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        wrong = copy.deepcopy(selection); wrong["snapshot"]["snapshotId"] = "other"
        with self.assertRaises(qualification.Failure): session.verify({"selection": wrong, "runtime": runtime})
        with self.assertRaises(qualification.Failure): session.start(99, self.now + 99)
        session = qualification.BuildVerifierSession(self.app, selection, self.request["runtime"],
            assert_current=self.fence, monotonic=lambda: self.clock, now=lambda: self.now)
        session.start(2, self.now + 2)
        original = self.app.verify_runtime
        reads = []
        def late(*args, **kwargs):
            result = original(*args, **kwargs); reads.append(True); self.clock = 2.0; return result
        self.app.verify_runtime = late
        with self.assertRaises(qualification.Failure): session.verify({"selection": selection, "runtime": runtime})
        self.assertTrue(reads, "deadline refusal must occur after real verification I/O")

    def test_session_freezes_inputs_and_refuses_a_replaced_original_lock_after_io(self):
        session, selection = self.boot_session()
        session.start(2, self.now + 2)
        selection["snapshot"]["snapshotId"] = "other"
        self.assertNotEqual(session.selection, selection)
        runtime = {key: self.active[key] for key in qualification.RUNTIME_FIELDS}
        original = self.app.verify_runtime
        reads = []
        def replaced(*args, **kwargs):
            result = original(*args, **kwargs); reads.append(True)
            self.fence.side_effect = qualification.Failure()
            return result
        self.app.verify_runtime = replaced
        with self.assertRaises(qualification.Failure): session.verify({"selection": session.selection, "runtime": runtime})
        self.assertTrue(reads, "the original lock must be rechecked after I/O")

    def test_boot_offer_rejects_boolean_version_even_when_manifest_binds_its_bytes(self):
        session, _ = self.boot_session()
        raw = qualification.packed({"schema": "zeros.build-boot-support/v1", "version": True})
        self.manifest["files"][-1]["sha256"] = hashlib.sha256(raw).hexdigest()
        read = self.app.read
        self.app.read = lambda path, *args: raw if path.endswith("/lib/zeros/build-boot-support.json") else read(path, *args)
        with self.assertRaises(qualification.Failure): session.start(2, self.now + 2)


if __name__ == "__main__": unittest.main()
