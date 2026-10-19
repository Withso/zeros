"""Real sanitation and immutable qualification files; synthetic base fixture."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import test_computer_build as fixture
from test_computer_build_qualification import qualification


class Sanitation(unittest.TestCase):
    tearDown = fixture.Fixture.tearDown
    optional_policy = fixture.Fixture.optional_policy
    mkdir = fixture.Fixture.mkdir
    write = fixture.Fixture.write
    baseline = fixture.Fixture.baseline
    sanitation_request = fixture.Fixture.sanitation_request

    def setUp(self):
        fixture.Fixture.setUp(self)
        compat_path = self.root / "opt/zeros-bootstrap/compatibility.json"
        compat = json.loads(compat_path.read_bytes())
        compat["buildQualificationVersion"] = 1
        for name in ("computer-boot-integrity.py", "computer-build-qualification.py"):
            raw = fixture.SOURCE.with_name(name).read_bytes()
            path = "/opt/zeros-bootstrap/" + name
            self.write(path, raw, 0o555)
            compat["protectedFiles"].append({"path": path, "mode": "0555", "sha256": fixture.build.sha(raw)})
        raw = fixture.build.packed(compat)
        self.write("/opt/zeros-bootstrap/compatibility.json", raw, 0o444)
        self.compatibility = "bc1-" + fixture.build.sha(raw)
        self.tcb["baseCompatibilityId"] = self.compatibility
        self.request = self.sanitation_request()
        evidence = json.loads((fixture.SOURCE.parents[3] / "packages/protocol/src/__tests__/fixtures/cloud-build-qualification.valid.json").read_bytes())
        evidence["scope"].update(buildId=fixture.JOB["buildId"], configId=fixture.JOB["buildId"])
        evidence["builder"].update(operationKey="computer-build:" + fixture.JOB["buildId"], helperFence=7, workerFence=7)
        evidence["base"].update(baseImageId="fixture-base", baseCompatibilityId=self.compatibility,
            compatibilitySha256=self.compatibility[4:], protectedContractSha256=self.request["manifest"]["protectedContractDigest"])
        evidence["runtime"].update(runtimeId=fixture.RUNTIME, manifestSha256=fixture.RUNTIME[3:])
        report = json.loads((fixture.SOURCE.parents[2] / "__tests__/fixtures/cloud-computer-self-test.valid.json").read_bytes())
        report["runtime"].update(runtimeId=fixture.RUNTIME, manifestSha256=fixture.RUNTIME[3:], baseCompatibilityId=self.compatibility)
        for key in ("qualifiedAt", "policy", "results"): evidence[key] = report[key]
        evidence["reportSha256"] = qualification.digest(report)
        evidence["sanitationManifestSha256"] = self.request["manifestSha256"]
        document = qualification.integrity_document(evidence, {"fixture": True}, {"fixture": True})
        evidence["base"]["bootIntegritySha256"] = qualification.digest(document)
        self.values = {"integrity.json": document, "evidence.json": evidence, "report.json": report}
        self.store = qualification.QualificationStore(self.root, uid=os.getuid(), gid=os.getgid())
        self.store.publish(fixture.JOB["buildId"], self.values)
        self.request["qualification"] = {"evidenceSha256": qualification.digest(evidence)}
        self.directory = self.root / "srv/zeros/runtime-installs/build-qualifications" / fixture.JOB["buildId"]
        loader = patch.object(self.app, "qualification_module", return_value=qualification)
        loader.start(); self.addCleanup(loader.stop)

    def test_real_sanitation_retains_all_original_records_and_clears_private_bytes(self):
        private = self.write("/root/.ssh/fixture", b"synthetic private fixture", 0o600)
        original = {name: ((self.directory / name).read_bytes(), (self.directory / name).stat().st_ino) for name in self.values}
        self.assertTrue(self.app.sanitize(self.request)["clean"])
        self.assertEqual(private.read_bytes(), b"")
        for name, (raw, inode) in original.items():
            self.assertEqual((self.directory / name).read_bytes(), raw)
            self.assertEqual((self.directory / name).stat().st_ino, inode)
            self.assertEqual((self.directory / name).stat().st_mode & 0o777, 0o444)

    def test_record_replacement_during_private_cleanup_cannot_be_adopted(self):
        original = self.app.empty_private_state
        file = self.directory / "integrity.json"
        raw, inode = file.read_bytes(), file.stat().st_ino
        def empty():
            original()
            file.rename(self.directory.parent / "displaced-fixture")
            file.write_bytes(raw); file.chmod(0o444)
        with patch.object(self.app, "empty_private_state", side_effect=empty):
            with self.assertRaises(fixture.build.Failure): self.app.sanitize(self.request)
        self.assertNotEqual(file.stat().st_ino, inode)
        self.assertEqual(file.read_bytes(), raw)

    def test_partial_unacknowledged_foreign_or_changed_records_refuse_before_wipe(self):
        for change in ("partial", "unacknowledged", "foreign", "bytes"):
            with self.subTest(change=change), patch.object(self.app, "empty_private_state") as wipe:
                file = self.directory / "integrity.json"
                raw = file.read_bytes()
                if change == "partial": file.unlink()
                elif change == "unacknowledged": self.request.pop("qualification")
                elif change == "foreign": self.request["qualification"] = {"evidenceSha256": "0" * 64}
                else: file.chmod(0o600); file.write_bytes(b"{}"); file.chmod(0o444)
                with self.assertRaises(fixture.build.Failure): self.app.sanitize(self.request)
                wipe.assert_not_called()
                if file.exists(): file.chmod(0o600)
                file.write_bytes(raw); file.chmod(0o444)
                self.request["qualification"] = {"evidenceSha256": qualification.digest(self.values["evidence.json"])}


if __name__ == "__main__": unittest.main()
