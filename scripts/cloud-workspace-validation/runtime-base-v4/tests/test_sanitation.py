"""Real base-template sanitation against an owned synthetic filesystem."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sanitation_fixtures", HERE / "test_bootstrap.py")
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class BaseSanitationTests(unittest.TestCase):
    tearDown = fixtures.BootstrapTests.tearDown
    download = fixtures.BootstrapTests.download

    def setUp(self):
        fixtures.BootstrapTests.setUp(self)
        # FakeMounts records the bind contract without mounting. Supply the
        # logical empty skeleton that the real bind exposes to the template.
        for name in ("repos", ".zeros-setup", "state", "managed-settings", "home/agent", "home/capture"):
            self.app.path("/srv/zeros/files/" + name).mkdir(parents=True, exist_ok=True)
        for name in ("state/workspaces", "home/agent", "home/capture"):
            self.app.path("/srv/zeros/" + name).mkdir(parents=True, exist_ok=True)

    def sanitize(self):
        template = fixtures.template("sanitize.py")
        listdir = os.listdir

        def rooted_listdir(path):
            if isinstance(path, str) and path.startswith("/") and not path.startswith(str(self.root) + "/"):
                path = self.app.path(path)
            return listdir(path)

        # Route the old template's absolute paths as well as the new app.path
        # boundary. The shipped entrypoint still has no injectable root.
        with mock.patch.object(template, "Path", side_effect=self.app.path, create=True), \
             mock.patch.object(template.os, "listdir", side_effect=rooted_listdir):
            return template.sanitize_base(self.app)

    def write(self, path, data, mode=0o600):
        target = self.app.path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(mode)
        return target

    def test_base_sanitation_overwrites_incremental_private_and_generated_entries(self):
        self.write("/etc/zeros/cloud-worker.json", json.dumps({"version": 4}).encode(), 0o444)
        self.write("/opt/zeros-bootstrap/computer-build.py", (HERE.parent / "computer-build.py").read_bytes(), 0o555)
        private = ("/root/.ssh/authorized_keys", "/home/user/.codex/auth.json", "/srv/zeros/setup/old",
                   "/root/zeros-base-v4-builds/build/result.json", "/tmp/zeros-v2-test-base-fixture/output")
        for path in private: self.write(path, b"synthetic private bytes")
        generated = ("/opt/zeros/disk-epoch", "/opt/zeros/sessions/boot.json")
        before = {path: self.app.path(path).read_bytes() for path in (*private, *generated)}
        inodes = {path: self.app.path(path).stat().st_ino for path in before}
        self.assertTrue(self.sanitize()["clean"])
        captured = {**before, **{path: self.app.path(path).read_bytes() for path in before if self.app.path(path).exists()}}
        self.assertEqual([path for path, data in captured.items() if data], [], "base capture retained private bytes")
        self.assertEqual({path: self.app.path(path).stat().st_ino for path in before}, inodes)
        self.assertEqual(self.app.read("/run/zeros/active-runtime.json", 16384, 0o600), b"")

    def test_base_sanitation_retains_only_empty_projection_entries(self):
        self.write("/etc/zeros/cloud-worker.json", json.dumps({"version": 4}).encode(), 0o444)
        self.write("/opt/zeros-bootstrap/computer-build.py", (HERE.parent / "computer-build.py").read_bytes(), 0o555)
        targets = [self.write("/srv/zeros/files/" + name + "/old", b"synthetic private bytes")
                   for name in ("state", "managed-settings", "home/agent", "home/capture")]
        self.sanitize()
        verifier = fixtures.template("verify.py")
        verifier.verify_empty_base_state(fixtures.b, self.app)
        for target in targets:
            self.assertTrue(target.is_file())
            self.assertEqual(target.read_bytes(), b"")
            target.write_bytes(b"nonempty residue")
            with self.assertRaises(fixtures.b.Failure): verifier.verify_empty_base_state(fixtures.b, self.app)
            target.write_bytes(b"")
        self.app.atomic(fixtures.b.ACTIVE, b"null")
        with self.assertRaises(fixtures.b.Failure): verifier.verify_empty_base_state(fixtures.b, self.app)

    def test_private_verifier_does_not_treat_empty_aliases_as_sanitized(self):
        verifier = fixtures.template("verify.py")
        other = self.write("/outside/empty", b"")
        target = self.app.path("/root/.netrc")
        target.parent.mkdir(parents=True, exist_ok=True)
        for kind in ("symlink", "hardlink", "fifo"):
            with self.subTest(kind=kind):
                if kind == "symlink": target.symlink_to(other)
                elif kind == "hardlink": os.link(other, target)
                else: os.mkfifo(target)
                try:
                    self.assertFalse(verifier.private_state_clean(self.root, cold_boot=False))
                finally:
                    target.unlink()


if __name__ == "__main__":
    unittest.main()
