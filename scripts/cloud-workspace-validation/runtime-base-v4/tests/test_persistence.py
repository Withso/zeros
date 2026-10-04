"""Restore must establish Boat-safe storage before any runtime accepts work."""
import json
import io
import contextlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

import test_bootstrap as fixtures

b = fixtures.b
NAMES = ("files", "state", "home", "repos")


class PersistenceTests(unittest.TestCase):
    setUp = fixtures.BootstrapTests.setUp
    tearDown = fixtures.BootstrapTests.tearDown
    download = fixtures.BootstrapTests.download
    install = fixtures.BootstrapTests.install
    cli = fixtures.BootstrapTests.cli

    @property
    def backing(self):
        return self.root / "home/user/.zeros-persist"

    @property
    def record(self):
        return self.root / "run/zeros/persistence.json"

    def test_every_boot_verifies_and_records_all_binds_without_overwriting_data(self):
        self.assertTrue(self.record.exists(), "boot did not attest persistent mounts")
        self.assertEqual(self.backing.stat().st_mode & 0o777, 0o755)
        first = json.loads(self.record.read_bytes())
        self.assertEqual(first["schema"], "zeros.persistence/v1")
        self.assertEqual(first["bootId"], fixtures.BOOT)
        self.assertEqual([item["name"] for item in first["mounts"]], list(NAMES))
        self.assertEqual(self.record.stat().st_mode & 0o777, 0o600)
        content = self.backing / "files" / "keep.txt"
        content.write_text("workspace data")
        count = len(self.mounts.calls)
        self.app.boot()
        self.assertEqual(len(self.mounts.calls), count)
        self.assertEqual(content.read_text(), "workspace data")
        self.assertEqual(json.loads(self.record.read_bytes()), first)

    def test_host_repo_alias_uses_the_files_repos_directory(self):
        physical = self.backing / "files/repos"
        self.assertTrue(physical.is_dir())
        target = self.root / "srv/zeros/repos"
        self.assertEqual(self.mounts.links[str(target)], str(physical))
        (physical / "keep.txt").write_text("template repository")
        self.app.boot()
        self.assertEqual((physical / "keep.txt").read_text(), "template repository")
        record = json.loads(self.record.read_bytes())["mounts"][-1]
        self.assertEqual(record["source"], "/home/user/.zeros-persist/files/repos")
        self.assertEqual(record["target"], "/srv/zeros/repos")

    def test_host_file_publication_directories_keep_their_ownership_without_binds(self):
        for name, mode in (("setup", 0o700), ("log", 0o750), ("managed-settings", 0o750)):
            with self.subTest(name=name):
                logical = self.root / "srv/zeros" / name
                self.assertTrue(logical.is_dir())
                self.assertEqual(logical.stat().st_mode & 0o777, mode)
                self.assertEqual(logical.stat().st_uid, self.app.uid)
                self.assertNotIn(str(logical), self.mounts.links)
                self.assertFalse((self.backing / name).exists())
                (logical / "host-file").write_text("preserve")
                self.app.boot()
                self.assertEqual((logical / "host-file").read_text(), "preserve")

    def test_setup_staging_is_private_and_inside_the_files_bind(self):
        private = self.backing / "files/.zeros-setup"
        self.assertTrue(private.is_dir())
        self.assertEqual(private.stat().st_mode & 0o777, 0o710)
        self.assertEqual(private.stat().st_uid, self.app.uid)
        self.assertEqual(private.stat().st_gid, self.app.account("agent")[1])
        (private / "seed").mkdir()
        (private / "seed/preserved").write_text("checkout backup")
        self.app.boot()
        self.assertEqual((private / "seed/preserved").read_text(), "checkout backup")

    def test_empty_engine_projection_mount_points_are_recreated_inside_files(self):
        files = self.backing / "files"
        for name in ("state", "home/agent", "home/capture", "managed-settings"):
            point = files / name
            self.assertTrue(point.is_dir(), "engine projection mount point is missing")
            self.assertEqual(point.stat().st_mode & 0o777, 0o755)
            self.assertEqual(list(point.iterdir()), [])
            point.rmdir()  # Template sanitation may remove an empty placeholder.
        self.app.boot()
        for name in ("state", "home/agent", "home/capture", "managed-settings"):
            self.assertTrue((files / name).is_dir())
        (files / "state/hidden").write_text("unexpected")
        code, output = self.cli(["boot"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["failedChecks"], ["base_compatibility"])
        self.assertFalse(self.record.exists())

    def test_restore_repairs_missing_mounts_even_with_the_same_boot_id(self):
        self.assertTrue(self.record.exists())
        self.mounts.links.clear()
        count = len(self.mounts.calls)
        self.app.boot()
        self.assertEqual(len(self.mounts.calls) - count, len(NAMES))
        self.app.require_persistence()

    def test_partial_mount_failure_has_no_readiness_and_retries_missing_binds_only(self):
        self.mounts.links.clear()
        self.mounts.calls.clear()
        self.mounts.fail = str(self.root / "srv/zeros/home")
        code, output = self.cli(["boot"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["failedChecks"], ["base_compatibility"])
        self.assertFalse(self.record.exists())
        self.assertEqual(len(self.mounts.calls), 2)
        self.mounts.fail = None
        self.app.boot()
        self.assertEqual(len(self.mounts.calls), len(NAMES))
        self.app.require_persistence()

    def test_symlinks_in_each_physical_or_logical_ancestor_are_refused(self):
        for relative in ("home/user/.zeros-persist/files", "home/user/.zeros-persist", "home/user", "srv/zeros/files"):
            with self.subTest(path=relative):
                target = self.root / relative
                self.assertTrue(target.is_dir())
                saved = self.root / "saved"
                target.rename(saved)
                target.symlink_to(saved, target_is_directory=True)
                try:
                    code, output = self.cli(["boot"])
                    self.assertEqual(code, 1)
                    self.assertEqual(json.loads(output)["failedChecks"], ["root_ownership"])
                    self.assertFalse(self.record.exists())
                finally:
                    target.unlink()
                    saved.rename(target)
                self.app.boot()

    def test_unmounted_nonempty_target_is_not_silently_hidden_or_migrated(self):
        target = self.root / "srv/zeros/files"
        self.assertTrue(target.is_dir())
        self.mounts.links.pop(str(target))
        (target / "unexpected").write_text("preserve")
        code, output = self.cli(["boot"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["failedChecks"], ["base_compatibility"])
        self.assertEqual((target / "unexpected").read_text(), "preserve")
        self.assertFalse(self.record.exists())

    def test_wrong_backing_mode_fails_closed_before_any_remount(self):
        state = self.backing / "state"
        state.chmod(0o777)
        self.mounts.calls.clear()
        code, output = self.cli(["boot"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["failedChecks"], ["file_mode"])
        self.assertFalse(self.record.exists())
        self.assertEqual(self.mounts.calls, [])

    def test_install_and_dispatch_refuse_missing_stale_or_unmounted_evidence(self):
        self.assertTrue(self.record.exists())
        original = self.record.read_bytes()
        for problem in ("missing", "stale", "unmounted", "wrong-source"):
            with self.subTest(problem=problem):
                if problem == "missing":
                    self.record.unlink()
                elif problem == "stale":
                    value = json.loads(original)
                    value["bootId"] = "22222222-2222-4222-8222-222222222222"
                    self.record.write_text(json.dumps(value))
                elif problem == "unmounted":
                    self.mounts.links.pop(str(self.root / "srv/zeros/files"))
                else:
                    self.mounts.links[str(self.root / "srv/zeros/files")] = str(self.backing / "home")
                with mock.patch.object(self.host, "cgroup") as cgroup, mock.patch.object(b.os, "execve") as execute:
                    for command in (["install", "--stdin"], ["dispatch"]):
                        code, output = self.cli(command)
                        self.assertNotEqual(code, 0)
                        self.assertEqual(json.loads(output)["failedChecks"], ["base_compatibility"])
                    cgroup.assert_not_called()
                    execute.assert_not_called()
                self.assertEqual(self.downloads, 0)
                self.assertEqual(self.app.status()["hostState"], "failed")
                self.record.write_bytes(original)
                self.record.chmod(0o600)
                self.mounts.links[str(self.root / "srv/zeros/files")] = str(self.backing / "files")

    def test_boot_fills_an_empty_machine_id_once_and_rejects_links(self):
        machine = self.root / "etc/machine-id"
        machine.touch(mode=0o444, exist_ok=True)
        machine.chmod(0o644)
        machine.write_bytes(b"")
        machine.chmod(0o444)
        self.app.boot()
        identity = machine.read_text()
        self.assertRegex(identity, r"^[0-9a-f]{32}\n$")
        self.assertNotEqual(identity, "0" * 32 + "\n")
        self.app.boot()
        self.assertEqual(machine.read_text(), identity)
        machine.unlink()
        other = self.root / "other-id"
        other.write_bytes(b"")
        machine.symlink_to(other)
        code, output = self.cli(["boot"])
        self.assertNotEqual(code, 0)
        self.assertFalse(self.record.exists())
        self.assertEqual(other.read_bytes(), b"")
        self.assertNotIn(str(other).encode(), output)

    def test_machine_id_fifo_is_rejected_without_a_blocking_open(self):
        machine = self.root / "etc/machine-id"
        machine.unlink()
        os.mkfifo(machine, 0o600)
        original = os.open
        def checked(name, flags, *args, **kwargs):
            if name == "machine-id":
                self.assertTrue(flags & os.O_NONBLOCK, "machine-id FIFO would block boot")
            return original(name, flags, *args, **kwargs)
        with mock.patch.object(b.os, "open", side_effect=checked):
            code, output = self.cli(["boot"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["failedChecks"], ["file_inventory"])
        self.assertFalse(self.record.exists())

    def test_live_probe_failure_retains_private_evidence_and_only_a_closed_public_line(self):
        spec = importlib.util.spec_from_file_location("persistence_probe", fixtures.HERE.parent / "persistence_probe.py")
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        output = io.StringIO()
        bootstrap_spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _module: None))
        with mock.patch.object(probe.importlib.util, "spec_from_file_location", return_value=bootstrap_spec), \
             mock.patch.object(probe.importlib.util, "module_from_spec", return_value=b), \
             mock.patch.object(b, "Bootstrap", return_value=self.app), \
             mock.patch.object(self.app, "wait_ready", side_effect=b.Failure("base_compatibility")), \
             contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
            probe.main("verify")
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {
            "schema": "zeros.diagnostic/v1", "component": "base", "stage": "resume", "ok": False,
            "exitCode": 1, "timedOut": False, "failedChecks": ["base_compatibility"],
        })
        private = self.app.path(b.PRIVATE_FAILURES)
        self.assertTrue(private.exists(), "persistence probe failure evidence was dropped")
        self.assertEqual(private.stat().st_mode & 0o777, 0o600)
        record = json.loads(private.read_bytes())
        self.assertEqual(record["stage"], "resume")
        self.assertEqual(record["failedChecks"], ["base_compatibility"])
        self.assertNotIn(str(self.root), output.getvalue() + private.read_text())


class KernelBindTests(unittest.TestCase):
    def test_mount_table_and_inode_identity_both_have_to_match(self):
        source, target = "/home/user/.zeros-persist/files", "/srv/zeros/files"
        raw = f"1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 {source} {target} rw - ext4 /dev/root rw\n".encode()
        mounts = b.BindMounts()
        metadata = types.SimpleNamespace(st_dev=os.makedev(8, 1), st_ino=123)
        with mock.patch.object(b.os, "fstat", return_value=metadata), mock.patch.object(mounts, "table", return_value=b.parse_mountinfo(raw)) as table:
            self.assertEqual(mounts.verify(source, target, 10, 11), {"device": metadata.st_dev, "inode": 123})
            for field, wrong in (("device", "8:2"), ("root", "/srv/elsewhere"), ("source", "/dev/other"),
                                 ("filesystem", "tmpfs"), ("options", ["ro"])):
                with self.subTest(field=field):
                    table.return_value = b.parse_mountinfo(raw)
                    table.return_value[-1][field] = wrong
                    with self.assertRaises(b.Failure):
                        mounts.verify(source, target, 10, 11)
            for extra in (target, target + "/nested", source, "/home/user/.zeros-persist"):
                with self.subTest(overlay=extra):
                    table.return_value = b.parse_mountinfo(raw)
                    table.return_value.append({**table.return_value[-1], "target": extra})
                    with self.assertRaises(b.Failure):
                        mounts.verify(source, target, 10, 11)
            table.return_value = b.parse_mountinfo(raw)
            with mock.patch.object(b.os, "fstat", side_effect=[metadata, types.SimpleNamespace(st_dev=metadata.st_dev, st_ino=124)]):
                with self.assertRaises(b.Failure):
                    mounts.verify(source, target, 10, 11)

    def test_mountinfo_paths_are_unescaped_and_reads_are_bounded(self):
        raw = b"1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /with\\040space\\134slash /target rw - ext4 /dev/root rw\n"
        self.assertEqual(b.parse_mountinfo(raw)[1]["root"], "/with space\\slash")
        for invalid in (b"", b"not mountinfo", b" " * (2 * 1024**2 + 1)):
            with self.assertRaises(b.Failure):
                b.parse_mountinfo(invalid)

    def test_real_bind_mounts_in_an_isolated_user_and_mount_namespace(self):
        if sys.platform != "linux":
            self.skipTest("Linux mount namespaces required")
        try:
            supported = subprocess.run(["unshare", "--user", "--map-root-user", "--mount", "true"],
                                       capture_output=True, timeout=10).returncode == 0
        except FileNotFoundError:
            supported = False
        if not supported:
            self.skipTest("unprivileged mount namespaces unavailable")
        # The child owns a private namespace; no host mount or directory is
        # changed. It exercises real mountinfo and inode checks, including the
        # two logical repo aliases and recovery after a partially lost mount set.
        program = r'''
import importlib.util, os, pathlib, subprocess, sys
spec = importlib.util.spec_from_file_location('bootstrap', sys.argv[1])
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
root = pathlib.Path(sys.argv[2])
(root / 'etc').mkdir()
app = b.Bootstrap(root, boot_id=lambda: '12345678-1234-4234-8234-123456789abc')
app.accounts = {name: (0, 0) for name in ('user', 'agent', 'capture', 'engine')}
record = app.persistence(create=True)
assert len(record['mounts']) == 4
assert app.persistence() == record
files = root / 'srv/zeros/files'
(files / 'repos/old').mkdir()
(files / 'repos/old/contents').write_text('keep')
(files / 'repos/old').rename(files / 'repos/new')
assert (root / 'srv/zeros/repos/new/contents').read_text() == 'keep'
assert (root / 'home/user/.zeros-persist/files/repos/new/contents').read_text() == 'keep'
assert app.persistence(create=True) == record
subprocess.run(['umount', str(root / 'srv/zeros/home')], check=True, capture_output=True)
try:
    app.persistence()
except b.Failure as error:
    assert error.checks == ['base_compatibility']
else:
    raise AssertionError('missing mount accepted')
assert app.persistence(create=True) == record
spec = importlib.util.spec_from_file_location('persistence_probe', sys.argv[3])
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
with app.directory('/run/zeros', create=True, mode=0o700):
    pass
app.atomic(b.PERSIST_RECORD, b.packed(record))
app.wait_ready = app.require_persistence
assert probe.probe(app, 'cold')['repoAliases']
assert probe.probe(app, 'seed')['templateIdentityCleared']
assert not app.path('/etc/machine-id').read_bytes()
# Recreate the mounts like an overlay restore, with the same underlying data
# and a sanitized machine-id. No early system service is involved.
for name, *_ in reversed(b.PERSIST_LAYOUT):
    subprocess.run(['umount', str(root / 'srv/zeros' / name)], check=True, capture_output=True)
record = app.persistence(create=True)
app.atomic(b.PERSIST_RECORD, b.packed(record))
assert probe.probe(app, 'rename')['machineIdPresent']
for name, *_ in reversed(b.PERSIST_LAYOUT):
    subprocess.run(['umount', str(root / 'srv/zeros' / name)], check=True, capture_output=True)
record = app.persistence(create=True)
app.atomic(b.PERSIST_RECORD, b.packed(record))
assert probe.probe(app, 'verify')['oldPathsAbsent']
for name, *_ in reversed(b.PERSIST_LAYOUT):
    subprocess.run(['umount', str(root / 'srv/zeros' / name)], check=True, capture_output=True)
'''
        with tempfile.TemporaryDirectory(prefix="zeros-persistence-mount-") as root:
            result = subprocess.run(["unshare", "--user", "--map-root-user", "--mount", "python3", "-I", "-c", program,
                                     str(fixtures.HERE.parent / "bootstrap.py"), root, str(fixtures.HERE.parent / "persistence_probe.py")],
                                    capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode())


class LiveProbeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("persistence_probe", fixtures.HERE.parent / "persistence_probe.py")
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_live_probe_requires_prior_session_bytes_after_both_renames(self):
        self.probe.tree_operation("seed", self.root)
        self.probe.tree_operation("rename", self.root)
        self.probe.tree_operation("verify", self.root)
        self.assertFalse((self.root / "same-before").exists())
        self.assertFalse((self.root / "from/move-before").exists())

    def test_live_probe_rejects_reverted_duplicated_or_empty_directories(self):
        for problem in ("reverted", "duplicated", "empty"):
            with self.subTest(problem=problem), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.probe.tree_operation("seed", root)
                self.probe.tree_operation("rename", root)
                if problem == "reverted":
                    (root / "same-after").rename(root / "same-before")
                elif problem == "duplicated":
                    (root / "from/move-before").mkdir()
                else:
                    (root / "into/move-after/nested/before.txt").unlink()
                with self.assertRaises((AssertionError, OSError)):
                    self.probe.tree_operation("verify", root)


if __name__ == "__main__":
    unittest.main()
