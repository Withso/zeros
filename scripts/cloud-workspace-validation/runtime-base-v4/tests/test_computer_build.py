import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "computer-build.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("computer_build", SOURCE)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
JOB = {"buildId": "11111111-1111-4111-8111-111111111111", "workerFence": 7}
RUNTIME = "r1-" + "a" * 64


class Logs(unittest.TestCase):
    def test_literal_redaction_at_every_boundary_and_end(self):
        secret = "synthetic-clone-credential"
        for split in range(1, len(secret)):
            redact = build.LogFilter([secret])
            output = redact.push("stdout", "before " + secret[:split])
            output += redact.push("stdout", secret[split:] + "\nafter\n") + redact.finish("stdout")
            self.assertEqual(output, "before [redacted]\nafter\n")
        redact = build.LogFilter([secret])
        self.assertEqual(redact.push("stdout", "synthetic-clo") + redact.finish("stdout"), "[redacted]")

    def test_shapes_controls_and_unbounded_line(self):
        redact = build.LogFilter([])
        token = "ghs_" + "fixture" * 8
        output = redact.push("stderr", "\x1b[31mAuthorization: Bea") + redact.push("stderr", "rer " + token + "\n")
        self.assertNotIn(token, output)
        self.assertNotIn("\x1b", output)
        output = redact.push("stdout", "x" * 2_000_000) + redact.push("stdout", "\nnext\n")
        self.assertLess(len(output.encode()), 9000)
        self.assertIn("truncated", output)
        self.assertIn("next\n", output)

    def test_escape_removal_cannot_reconstruct_a_known_literal(self):
        redact = build.LogFilter(["synthetic-credential"])
        output = redact.push("stdout", "synthetic-\x1b[31mcredential\x1b[0m\n")
        self.assertNotIn("synthetic-credential", output)

    def test_spool_is_one_mib_and_cursor_is_monotonic(self):
        with tempfile.TemporaryDirectory() as root:
            spool = build.InstallStore(Path(root), JOB)
            spool.initialize("fixture-input-digest")
            for i in range(180):
                spool.append("stdout", "é" * 4096)
            status = spool.status(0)
            self.assertTrue(status["truncated"])
            self.assertLessEqual(sum(len(row["text"].encode()) for row in spool.read()["chunks"]), 1_048_576)
            self.assertLessEqual(len(status["chunks"]), 8)
            self.assertGreater(status["nextAfter"], 1)
            self.assertGreater(spool.status(status["nextAfter"])["chunks"][0]["seq"], status["nextAfter"])


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = build.ComputerBuild(self.root, uid=os.getuid(), gid=os.getgid(), repo_uid=os.getuid(), repo_gid=os.getgid())
        # A base-owned bootstrap double verifies its call contract. The B4
        # inventory/extraction suites separately verify the bootstrap itself.
        self.write("/opt/zeros-bootstrap/bootstrap.py", """class Bootstrap:
    def __init__(self, **kwargs): pass
    def base(self): pass
    def current(self): return '""" + RUNTIME + """'
    def verify_runtime(self, runtime_id, full=True):
        assert runtime_id == '""" + RUNTIME + """' and full
        return {}, b'fixture-receipt'
""", 0o555)
        self.write("/opt/zeros-bootstrap/computer-build.py", SOURCE.read_text(), 0o555)
        self.write("/opt/zeros-bootstrap/computer-git-askpass.py", "base-owned askpass", 0o555)
        self.write("/etc/systemd/system/zeros-host.service", "[Service]\nExecStart=/opt/zeros-bootstrap/dispatch.sh\n", 0o444)
        self.write("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\nagent:x:10001:10001::/srv/zeros/home/agent:/bin/bash\n")
        self.write("/etc/group", "root:x:0:\nagent:x:10001:\n")
        self.write("/etc/subuid", "zeros-agent:100000:65536\n")
        self.write("/etc/subgid", "zeros-agent:100000:65536\n")
        self.write("/etc/sudoers", "root ALL=(ALL) ALL\n", 0o440)
        self.write("/etc/apparmor.d/zeros-cloud-engine", "fixture profile", 0o444)
        self.write("/opt/zeros-infra/" + RUNTIME + "/fixture", "verified runtime", 0o444)
        self.mkdir("/opt/zeros")
        (self.root / "opt/zeros/current").symlink_to("../zeros-infra/" + RUNTIME)
        protected = []
        for path in ("/opt/zeros-bootstrap/bootstrap.py", "/opt/zeros-bootstrap/computer-build.py", "/opt/zeros-bootstrap/computer-git-askpass.py", "/etc/systemd/system/zeros-host.service"):
            value = self.root / path.lstrip("/")
            protected.append({"path": path, "mode": format(value.stat().st_mode & 0o7777, "04o"), "sha256": build.sha(value.read_bytes())})
        contract = {"schema": "zeros.base-compatibility/v1", "protectedFiles": protected, "uids": {"agent": 10001, "capture": 10002, "engine": 10003, "coordinator": 10004}}
        raw = build.packed(contract)
        self.write("/opt/zeros-bootstrap/compatibility.json", raw, 0o444)
        self.compatibility = "bc1-" + build.sha(raw)
        self.tcb = {"schema": "zeros.computer-tcb-input/v1", **JOB, "runtimeId": RUNTIME, "baseCompatibilityId": self.compatibility, "action": "baseline"}

    def tearDown(self):
        self.temp.cleanup()

    def mkdir(self, path):
        value = self.root / path.lstrip("/")
        value.mkdir(parents=True, exist_ok=True)
        return value

    def write(self, path, text, mode=0o644):
        value = self.root / path.lstrip("/")
        value.parent.mkdir(parents=True, exist_ok=True)
        value.write_bytes(text.encode() if isinstance(text, str) else text)
        value.chmod(mode)
        return value

    def baseline(self):
        return self.app.verify_tcb(self.tcb)["protectedContractDigest"]

    def verify(self, digest):
        return self.app.verify_tcb({**self.tcb, "action": "verify", "protectedContractDigest": digest})

    def test_protected_file_and_compatibility_are_not_their_own_authority(self):
        digest = self.baseline()
        self.assertEqual(self.verify(digest)["protectedContractDigest"], digest)
        self.write("/opt/zeros-bootstrap/computer-build.py", "modified", 0o555)
        with self.assertRaises(build.Failure): self.verify(digest)
        self.write("/opt/zeros-bootstrap/compatibility.json", b'{}', 0o444)
        with self.assertRaises(build.Failure): self.baseline()

    def test_added_dropins_sudoers_apparmor_and_uid_change_fail(self):
        for path, value in (("/etc/systemd/system/zeros-host.service.d/override.conf", "override"),
                            ("/run/systemd/system/service.d/override.conf", "override"),
                            ("/etc/sudoers.d/addition", "new policy"),
                            ("/etc/apparmor.d/local/zeros-cloud-engine", "override")):
            with self.subTest(path=path):
                digest = self.baseline()
                target = self.write(path, value)
                with self.assertRaises(build.Failure): self.verify(digest)
                target.unlink()
        digest = self.baseline()
        self.write("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\nagent:x:10005:10001::/changed:/bin/bash\n")
        with self.assertRaises(build.Failure): self.verify(digest)

    def test_regular_package_install_is_allowed_and_protected_modes_links_are_not(self):
        digest = self.baseline()
        self.write("/usr/local/bin/custom-tool", "installed tool", 0o755)
        self.verify(digest)
        protected = self.root / "etc/systemd/system/zeros-host.service"
        protected.chmod(0o666)
        with self.assertRaises(build.Failure): self.verify(digest)
        protected.chmod(0o444)
        os.link(protected, self.root / "hardlink")
        with self.assertRaises(build.Failure): self.verify(digest)

    def test_writable_protected_ancestor_fails(self):
        digest = self.baseline()
        (self.root / "opt").chmod(0o777)
        with self.assertRaises(build.Failure): self.verify(digest)

    def test_subordinate_uid_and_gid_policy_is_protected(self):
        for path in ("/etc/subuid", "/etc/subgid"):
            with self.subTest(path=path):
                digest = self.baseline()
                self.write(path, "zeros-agent:200000:65536\n")
                with self.assertRaises(build.Failure): self.verify(digest)
                self.write(path, "zeros-agent:100000:65536\n")

    def test_approved_apparmor_mode_is_preserved_including_v4_unconfined_profile(self):
        path = "/sys/kernel/security/apparmor/profiles"
        self.write(path, "zeros-cloud-engine (unconfined)\n")
        digest = self.baseline()
        self.verify(digest)
        self.write(path, "zeros-cloud-engine (complain)\n")
        with self.assertRaises(build.Failure): self.verify(digest)
        self.write(path, "other-profile (enforce)\n")
        with self.assertRaises(build.Failure): self.baseline()

    def repository(self, *, lfs=False, unsafe_link=False):
        source = self.root / "origin"
        source.mkdir()
        def git(*args):
            return subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", *args], cwd=source,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout.decode().strip()
        git("init", "-q")
        (source / "file").write_text("version https://git-lfs.github.com/spec/v1\noid sha256:" + "a" * 64 + "\nsize 1\n" if lfs else "repository data")
        if unsafe_link: (source / "escape").symlink_to("/root/.ssh")
        git("add", ".")
        git("commit", "-qm", "fixture")
        commit = git("rev-parse", "HEAD")
        calls = []
        original = self.app.git
        def local_git(args, cwd, environment=None, timeout=60):
            calls.append((args, environment or {}))
            self.assertFalse(any("synthetic-clone-credential" in item for item in args))
            self.assertNotIn("synthetic-clone-credential", json.dumps(environment))
            args = [str(source) if item == "https://github.com/fixture/repo.git" and "fetch" in args else item for item in args]
            return original(["-c", "protocol.file.allow=always", *args], cwd, environment, timeout)
        self.app.git = local_git
        document = {"schema": "zeros.computer-repositories-input/v1", **JOB, "repositories": [{"id": "123", "owner": "fixture", "name": "repo", "ref": commit,
            "credential": {"token": "synthetic-clone-credential", "expiresAt": "2099-01-01T00:00:00Z"}}]}
        return document, commit, calls

    def test_shallow_repo_manifest_clean_remote_no_helpers_or_token_on_disk(self):
        document, commit, calls = self.repository()
        result = self.app.clone_repos(document)
        self.assertEqual(result["repositories"], [{"id": "123", "owner": "fixture", "name": "repo", "sha": commit}])
        repo = self.root / "srv/zeros/files/repos/fixture/repo"
        config = (repo / ".git/config").read_text()
        self.assertIn("https://github.com/fixture/repo.git", config)
        self.assertNotIn("credential", config)
        self.assertTrue((repo / ".git/shallow").exists())
        self.assertEqual((repo / "file").stat().st_uid, os.getuid())
        for path in self.root.rglob("*"):
            if path.is_file() and not path.is_symlink(): self.assertNotIn(b"synthetic-clone-credential", path.read_bytes())

    def test_empty_repository_list_does_not_create_repo_projection(self):
        result = self.app.clone_repos({"schema": "zeros.computer-repositories-input/v1", **JOB, "repositories": []})
        self.assertEqual(result["repositories"], [])
        self.assertFalse((self.root / "srv/zeros/files/repos").exists())

    def test_repository_access_with_umask_077_before_and_after_sanitize(self):
        # The ordinary suite checks exact parent modes. Running this suite as
        # root also exercises real access from the distinct workspace UID/GID.
        if os.geteuid() == 0:
            self.app.repo_uid = self.app.repo_gid = 10001
            self.assertNotEqual(self.app.uid, self.app.repo_uid)
        self.root.chmod(0o755)
        for path in ("/srv", "/srv/zeros", "/srv/zeros/files"):
            self.mkdir(path).chmod(0o755)
        document, _, _ = self.repository()
        original_umask = os.umask(0o077)
        try:
            repositories = self.app.clone_repos(document)["repositories"]
            private = self.root / "run/zeros/computer-build" / JOB["buildId"]
            self.assertEqual(private.stat().st_mode & 0o7777, 0o700)
            self.assertEqual(private.stat().st_uid, self.app.uid)

            def accessible():
                for path in ("srv/zeros/files/repos", "srv/zeros/files/repos/fixture"):
                    metadata = (self.root / path).stat()
                    self.assertEqual(metadata.st_mode & 0o7777, 0o755)
                    self.assertEqual((metadata.st_uid, metadata.st_gid), (self.app.uid, self.app.gid))
                repo = self.root / "srv/zeros/files/repos/fixture/repo"
                self.assertEqual(repo.stat().st_uid, self.app.repo_uid)
                identity = {"user": self.app.repo_uid, "group": self.app.repo_gid, "extra_groups": []} if os.geteuid() == 0 else {}
                result = subprocess.run([sys.executable, "-I", "-c",
                    "from pathlib import Path; import sys; p=Path(sys.argv[1]); "
                    "assert (p/'file').read_text() == 'repository data'; "
                    "q=p/'workspace-write'; q.write_text('writable'); q.unlink()", str(repo)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, **identity)
                self.assertEqual(result.returncode, 0, "workspace identity cannot access its checkout")

            accessible()
            manifest = {"schema": "zeros.computer-template/v1", "buildId": JOB["buildId"], "configId": JOB["buildId"], "baseImageId": "fixture-base",
                        "runtimeId": RUNTIME, "baseCompatibilityId": self.compatibility, "repositoryManifest": repositories, "protectedContractDigest": self.baseline()}
            # Sanitation must establish the contract even if a root recipe
            # tightened the repository parents after cloning.
            for path in ("srv/zeros/files/repos", "srv/zeros/files/repos/fixture"):
                (self.root / path).chmod(0o700)
            self.app.host = FakeHost()
            self.app.sanitize({"schema": "zeros.computer-sanitation-input/v1", **JOB, "manifest": manifest, "manifestSha256": build.sha(build.packed(manifest))})
            accessible()
            self.assertFalse(private.exists())
        finally:
            os.umask(original_umask)

    def test_lfs_and_escaping_repository_symlinks_fail_closed(self):
        document, _, _ = self.repository(lfs=True)
        with self.assertRaises(build.Failure): self.app.clone_repos(document)

    def test_repository_link_escape_is_rejected_before_ownership_traversal(self):
        document, _, _ = self.repository(unsafe_link=True)
        with self.assertRaises(build.Failure): self.app.clone_repos(document)

    def test_start_is_idempotent_and_fenced_even_after_lost_reply(self):
        class LocalHost:
            def install_command(self, _identity, _timeout): return ["/usr/bin/bash", "-euo", "pipefail"]
            def drain_install(self, _identity): pass
        self.app.host = LocalHost()
        self.app.clone_repos({"schema": "zeros.computer-repositories-input/v1", **JOB, "repositories": []})
        marker = self.root / "count"
        document = {"schema": "zeros.computer-install-input/v1", **JOB, "action": "start", "after": 0,
                    "script": "printf x >> " + str(marker), "timeoutSeconds": 2, "redactions": []}
        self.app.run_install(document)
        self.app.run_install(document)
        limit = time.monotonic() + 5
        while self.app.run_install({"schema": document["schema"], **JOB, "action": "poll", "after": 0})["state"] == "running":
            self.assertLess(time.monotonic(), limit)
            time.sleep(0.02)
        self.app.run_install(document)
        self.assertEqual(marker.read_text(), "x")
        with self.assertRaises(build.Failure): self.app.run_install({**document, "workerFence": 8})
        with self.assertRaises(build.Failure): self.app.run_install({**document, "script": "false"})
        try: os.waitpid(-1, 0)
        except ChildProcessError: pass

    def test_sanitize_preserves_repositories_runtime_and_manifest_but_removes_private_state(self):
        document, commit, _ = self.repository()
        repositories = self.app.clone_repos(document)["repositories"]
        # §23's physical root must survive; sanitation owns explicit private
        # targets through logical binds, never a recursive /home/user wipe.
        persistent = self.write("/home/user/.zeros-persist/files/retained", "retained data")
        for path in ("/root/.ssh/id", "/root/.bash_history", "/home/user/.git-credentials", "/srv/zeros/setup/admission", "/srv/zeros/state/workspaces/session",
                     "/srv/zeros/log/script", "/srv/zeros/home/agent/.bash_history", "/srv/zeros/home/capture/session",
                     "/srv/zeros/files/state/private", "/srv/zeros/managed-settings/settings.managed.toml",
                     "/opt/zeros/sessions/session", "/var/log/journal/private", "/opt/zeros/disk-epoch"):
            self.write(path, "private state")
        skeleton = {"/srv/zeros/home/agent": 0o755, "/srv/zeros/home/capture": 0o700,
                    "/srv/zeros/state": 0o700, "/srv/zeros/state/workspaces": 0o700,
                    "/srv/zeros/log": 0o750, "/srv/zeros/managed-settings": 0o750}
        for path, mode in skeleton.items(): self.mkdir(path).chmod(mode)
        managed = self.root / "srv/zeros/managed-settings/settings.managed.toml"
        managed.chmod(0o640)
        self.write("/etc/machine-id", "machine identity")
        self.write("/opt/zeros/disk-epoch", "123\n", 0o600)
        manifest = {"schema": "zeros.computer-template/v1", "buildId": JOB["buildId"], "configId": JOB["buildId"], "baseImageId": "fixture-base",
                    "runtimeId": RUNTIME, "baseCompatibilityId": self.compatibility, "repositoryManifest": repositories, "protectedContractDigest": self.baseline()}
        self.app.host = FakeHost()
        result = self.app.sanitize({"schema": "zeros.computer-sanitation-input/v1", **JOB, "manifest": manifest, "manifestSha256": build.sha(build.packed(manifest))})
        self.assertTrue(result["clean"])
        self.assertEqual(persistent.read_text(), "retained data")
        self.assertEqual((self.root / "srv/zeros/files/repos/fixture/repo/file").read_text(), "repository data")
        self.assertEqual((self.root / "opt/zeros-infra" / RUNTIME / "fixture").read_text(), "verified runtime")
        self.assertEqual((self.root / "etc/machine-id").read_bytes(), b"")
        self.assertFalse((self.root / "root/.ssh").exists())
        self.assertFalse((self.root / "srv/zeros/setup/admission").exists())
        self.assertFalse((self.root / "opt/zeros/sessions/session").exists())
        self.assertFalse((self.root / "srv/zeros/files/state").exists())
        for path, mode in skeleton.items():
            target = self.root / path.lstrip("/")
            self.assertTrue(target.is_dir())
            self.assertEqual(target.stat().st_mode & 0o7777, mode)
            self.assertEqual(target.stat().st_uid, os.getuid())
        self.assertEqual(managed.read_bytes(), b"")
        self.assertEqual(managed.stat().st_mode & 0o7777, 0o640)
        self.assertEqual(list((self.root / "srv/zeros/state/workspaces").iterdir()), [])
        self.assertEqual(list((self.root / "srv/zeros/home/agent").iterdir()), [])
        self.assertEqual(list((self.root / "srv/zeros/home/capture").iterdir()), [])
        self.assertEqual(json.loads((self.root / "srv/zeros/computer-template.json").read_bytes()), manifest)
        # The digest must remain meaningful on the archived template. Epoch
        # contents and private session payloads are explicit metadata exclusions.
        self.verify(manifest["protectedContractDigest"])


class FakeHost:
    def stop_host(self): pass
    def clear_journal(self): pass


class Install(unittest.TestCase):
    def test_install_script_enters_a_private_logical_repository_namespace(self):
        args = build.SystemHost().install_command(JOB["buildId"], 900)
        self.assertIn("--property=WorkingDirectory=/", args)
        self.assertEqual(args[-9:], ["/usr/bin/unshare", "--mount", "--propagation", "private", "--",
                                    "/usr/bin/python3", "-I", "/opt/zeros-bootstrap/computer-build.py", "install-shell"])

    def test_unknown_cgroup_status_is_not_evidence_of_drain(self):
        with patch.object(build, "bounded_command", return_value=(1, b"")):
            with self.assertRaises(build.Failure): build.SystemHost().drain_install(JOB["buildId"])

    def test_collected_unit_is_drained_only_with_positive_not_found_evidence(self):
        with patch.object(build, "bounded_command", side_effect=[(0, b""), (1, b""), (1, b"not-found\n")]):
            build.SystemHost().drain_install(JOB["buildId"])

    def test_root_service_has_strict_bash_deadline_and_bounded_cgroup(self):
        args = build.SystemHost().install_command(JOB["buildId"], 900)
        for option in ("--property=User=0", "--property=Group=0", "--property=KillMode=control-group", "--property=RuntimeMaxSec=900s", "--property=TasksMax=512",
                       "--property=ReadOnlyPaths=/opt/zeros-bootstrap", "--property=ProtectControlGroups=yes"):
            self.assertIn(option, args)
        self.assertIn("/usr/bin/unshare", args)

    def test_script_failure_timeout_and_split_logs(self):
        with tempfile.TemporaryDirectory() as root:
            store = build.InstallStore(Path(root), JOB)
            store.initialize("test")
            build.run_process(["/usr/bin/bash", "-euo", "pipefail"], "printf 'synthetic-'; printf 'credential\\n'; exit 7", 2, store,
                              build.LogFilter(["synthetic-credential"]), cwd=root)
            status = store.status(0)
            self.assertEqual(status["state"], "failed")
            self.assertEqual(status["exitCode"], 7)
            self.assertEqual("".join(row["text"] for row in status["chunks"]), "[redacted]\n")
        with tempfile.TemporaryDirectory() as root:
            store = build.InstallStore(Path(root), JOB)
            store.initialize("test")
            build.run_process(["/usr/bin/bash", "-euo", "pipefail"], "sleep 30 & wait", 0.1, store, build.LogFilter([]), cwd=root)
            self.assertTrue(store.status(0)["timedOut"])


if __name__ == "__main__":
    unittest.main()
