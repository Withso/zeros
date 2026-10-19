"""Installer admission and fixed verifier wiring; no runtime launch activation."""
import copy
import hashlib
import json
from pathlib import Path
import types
import unittest
from unittest import mock

import test_bootstrap as fixtures
import test_computer_build as build_fixtures

b = fixtures.b


class Install(unittest.TestCase):
    setUp = fixtures.BootstrapTests.setUp
    tearDown = fixtures.BootstrapTests.tearDown
    download = fixtures.BootstrapTests.download
    install = fixtures.BootstrapTests.install

    def selected(self):
        evidence = json.loads((fixtures.HERE.parents[3] / "packages/protocol/src/__tests__/fixtures/cloud-build-qualification.valid.json").read_bytes())
        for key in ("runtimeId", "manifestSha256", "archiveSha256", "engineProtocolVersion"):
            evidence["runtime"][key] = self.value["runtime"][key]
        evidence["base"].update(baseCompatibilityId=self.app.compat_id, compatibilitySha256=self.app.compat_id[4:])
        raw = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        self.value.update(purpose="workspace-setup", setup="e30", buildQualification={
            "mode": "build", "qualificationId": "11111111-1111-4111-8111-111111111111",
            "evidenceSha256": hashlib.sha256(raw).hexdigest(), "evidence": evidence,
            "snapshot": {"name": "fixture-alpha-computer-v1", "snapshotId": "snapshot_fixture", "treeSha256": "a" * 64}})
        return self.value["buildQualification"]

    def test_absent_and_explicit_full_keep_legacy_setup_without_a_verifier(self):
        self.value.update(purpose="workspace-setup", setup="e30")
        for full in (False, True):
            if full: self.value["buildQualification"] = {"mode": "full"}
            self.assertEqual(self.install(), 0)
        self.assertEqual(len([call for call in self.host.calls if isinstance(call, tuple) and call[0] == "setup"]), 2)

    def test_selected_input_uses_the_existing_installer_lock_and_fixed_base_session(self):
        selected = self.selected()
        module = types.SimpleNamespace(Failure=RuntimeError)
        module.validate_selection = mock.Mock(side_effect=copy.deepcopy)
        witness = object()
        def factory(app, selection, descriptor, *, assert_current):
            self.assertIs(app, self.app)
            self.assertEqual(selection, selected); self.assertEqual(descriptor, self.value["runtime"])
            self.assertTrue(callable(assert_current)); assert_current()
            with self.assertRaises(b.Failure):
                with self.app.lock("runtime-install.lock"): pass
            return witness
        module.BuildVerifierSession = mock.Mock(side_effect=factory)
        received = []
        self.host.setup = lambda root, payload, *, build_verifier: (received.append(build_verifier) or (0, []))
        with mock.patch.object(self.app, "build_qualification_module", return_value=module) as load:
            self.assertEqual(self.install(), 0)
        load.assert_called_once_with(self.app.compat_id)
        module.BuildVerifierSession.assert_called_once()
        self.assertEqual(len(received), 1)

    def test_external_base_and_runtime_mismatch_refuse_before_helper_import_or_install(self):
        for changed in ("base", "runtime"):
            with self.subTest(changed=changed):
                selected = self.selected()
                if changed == "base":
                    selected["evidence"]["base"].update(baseCompatibilityId="bc1-" + "a" * 64, compatibilitySha256="a" * 64)
                else: selected["evidence"]["runtime"]["archiveSha256"] = "f" * 64
                with mock.patch.object(self.app, "build_qualification_module") as load:
                    with self.assertRaises(b.Failure): self.install()
                    load.assert_not_called()
                self.assertEqual(self.downloads, 0)
                self.assertEqual(self.host.calls, [])

    def test_legacy_base_rejects_build_mode_without_loading_unpinned_helpers(self):
        selected = self.selected()
        file = self.root / "opt/zeros-bootstrap/compatibility.json"
        value = json.loads(file.read_bytes()); value.pop("buildQualificationVersion")
        raw = fixtures.canonical(value)
        file.chmod(0o600); file.write_bytes(raw); file.chmod(0o444)
        selected["evidence"]["base"].update(baseCompatibilityId="bc1-" + fixtures.digest(raw), compatibilitySha256=fixtures.digest(raw))
        with mock.patch.object(self.app, "build_qualification_module") as load:
            with self.assertRaises(b.Failure): self.install()
            load.assert_not_called()
        self.assertEqual(self.downloads, 0)

    def test_selection_is_for_workspace_setup_only_and_never_downgrades(self):
        for purpose in ("build", "qualification"):
            self.value.update(purpose=purpose, buildQualification={"mode": "full"})
            with self.assertRaises(b.Failure): self.install()
        self.value.update(purpose="workspace-setup", setup="e30", buildQualification={"mode": "full", "unexpected": True})
        with self.assertRaises(b.Failure): self.install()
        self.assertEqual(self.downloads, 0)

    def test_invalid_complete_selection_refuses_before_host_start_or_legacy_fallback(self):
        self.selected()["evidenceSha256"] = "0" * 64
        with self.assertRaises(b.Failure): self.install()
        self.assertEqual(self.host.calls, [])
        self.assertEqual(self.downloads, 0)

    def test_system_host_passes_only_the_fixed_session_to_real_transport(self):
        host, verifier = b.SystemHost(), object()
        with mock.patch.object(b, "run_setup", return_value=(0, [])) as run:
            self.assertEqual(host.setup("/opt/zeros-infra/r1-" + "a" * 64, "e30", build_verifier=verifier), (0, []))
        self.assertIs(run.call_args.kwargs["build_verifier"], verifier)
        self.assertEqual(run.call_args.args[0][1:], ["/opt/zeros-infra/r1-" + "a" * 64 + "/lib/zeros/setup-cloud-workspace.mjs", "--stdin"])

    def test_loader_executes_only_the_two_verified_byte_strings_even_after_path_replacement(self):
        self.app.base()
        marker = self.root / "unverified-helper-executed"
        for name in ("computer-boot-integrity.py", "computer-build-qualification.py"):
            with self.subTest(name=name):
                target = self.root / "opt/zeros-bootstrap" / name
                original = target.read_bytes()
                read = self.app.read
                changed = []
                def replaced(absolute, *args, **kwargs):
                    raw = read(absolute, *args, **kwargs)
                    if absolute == "/opt/zeros-bootstrap/computer-build-qualification.py" and not changed:
                        changed.append(True)
                        target.unlink()
                        target.write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('unexpected')\n")
                        target.chmod(0o555)
                    return raw
                try:
                    with mock.patch.object(self.app, "read", side_effect=replaced):
                        with self.assertRaises(b.Failure): self.app.build_qualification_module(self.app.compat_id)
                    self.assertTrue(changed)
                    self.assertFalse(marker.exists(), "a checked pathname was reopened for execution")
                finally:
                    target.unlink(); target.write_bytes(original); target.chmod(0o555)

    def test_build_and_sanitation_refuse_helper_replacement_after_their_tcb_check(self):
        builder = build_fixtures.build.ComputerBuild(self.root, uid=self.app.uid, gid=self.app.gid)
        marker = self.root / "unverified-build-helper-executed"
        for action in ("qualify_build", "sanitize"):
            for name in ("computer-build-qualification.py", "computer-boot-integrity.py"):
                with self.subTest(action=action, name=name):
                    self.app.base()
                    target = self.root / "opt/zeros-bootstrap" / name
                    original, changed = target.read_bytes(), []
                    def checked(_input, **options):
                        changed.append(True)
                        target.unlink()
                        target.write_text("from pathlib import Path\nPath(" + repr(str(marker)) +
                                          ").write_text('unexpected')\nraise RuntimeError('unverified fixture executed')\n")
                        target.chmod(0o555)
                        return ({}, self.app) if options.get("with_app") else {}
                    job = {"buildId": "11111111-1111-4111-8111-111111111111", "workerFence": 1}
                    if action == "qualify_build":
                        request = {**job, "runtime": self.value["runtime"],
                                   "base": {"baseCompatibilityId": self.app.compat_id}, "protectedContractSha256": "a" * 64}
                    else:
                        manifest = {"schema": "zeros.computer-template/v1", "buildId": job["buildId"], "configId": job["buildId"],
                                    "baseImageId": "fixture-base", "runtimeId": self.value["runtime"]["runtimeId"],
                                    "baseCompatibilityId": self.app.compat_id, "repositoryManifest": [], "protectedContractDigest": "a" * 64}
                        request = {**job, "schema": "zeros.computer-sanitation-input/v1", "manifest": manifest,
                                   "manifestSha256": fixtures.digest(build_fixtures.build.packed(manifest))}
                    try:
                        with mock.patch.object(builder, "verify_tcb", side_effect=checked):
                            with self.assertRaises((build_fixtures.build.Failure, RuntimeError)):
                                getattr(builder, action)(request)
                        self.assertEqual(len(changed), 1)
                        self.assertFalse(marker.exists(), "a build caller reopened an unchecked helper for execution")
                    finally:
                        target.unlink(); target.write_bytes(original); target.chmod(0o555)
                        marker.unlink(missing_ok=True)


if __name__ == "__main__": unittest.main()
