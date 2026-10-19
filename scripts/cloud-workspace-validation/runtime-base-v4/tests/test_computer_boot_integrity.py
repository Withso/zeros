import hashlib
import importlib.util
import os
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / "computer-boot-integrity.py"
spec = importlib.util.spec_from_file_location("computer_boot_integrity", SOURCE)
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)


def note(name, value, kind=3):
    def aligned(raw): return raw + b"\0" * (-len(raw) % 4)
    return struct.pack("<III", len(name), len(value), kind) + aligned(name) + aligned(value)


class Kernel(unittest.TestCase):
    def setUp(self):
        self.build_id = bytes.fromhex("1234" * 20)
        self.notes = note(b"Linux\0", b"fixture", 1) + note(b"GNU\0", self.build_id)
        self.uname = types.SimpleNamespace(machine="x86_64", release="6.8.0-fixture", version="#1 SMP fixture")
        self.files = {
            "/sys/kernel/notes": self.notes,
            "/proc/sys/kernel/osrelease": b"6.8.0-fixture\n",
            "/proc/sys/kernel/version": b"#1 SMP fixture\n",
            "/sys/kernel/security/lsm": b"lockdown,capability,yama,apparmor,bpf\n",
            "/sys/module/apparmor/parameters/enabled": b"Y\n",
            "/proc/sys/kernel/unprivileged_userns_clone": b"1\n",
            "/proc/sys/user/max_user_namespaces": b"1024\n",
            "/proc/sys/kernel/seccomp/actions_avail": b"kill_process kill_thread trap errno user_notif trace log allow\n",
            "/sys/fs/cgroup/cgroup.controllers": b"cpuset cpu io memory pids\n",
        }
        self.reads = []

    def read(self, name, maximum, filesystem):
        self.reads.append((name, maximum, filesystem))
        raw = self.files[name]
        if len(raw) > maximum: raise integrity.Failure()
        return raw

    def identity(self):
        return integrity.running_kernel_identity(read=self.read, uname=lambda: self.uname)

    def test_current_kernel_notes_and_controls_produce_closed_identity(self):
        result = self.identity()
        self.assertEqual(result["kernel"], {
            "architecture": "x86_64", "release": self.uname.release, "version": self.uname.version,
            "buildId": self.build_id.hex(), "notesSha256": hashlib.sha256(self.notes).hexdigest(),
            "features": {"cgroupV2": True, "userNamespaces": True, "seccompFilter": True, "apparmor": True},
        })
        self.assertEqual(result["features"]["schema"], "zeros.kernel-feature-policy/v1")
        self.assertLessEqual(len(integrity.packed(result["features"])), 4096)
        self.assertEqual(len(self.reads), len(self.files))
        self.assertEqual(next(row[1] for row in self.reads if row[0] == "/sys/kernel/notes"), 65536)

    def test_same_release_with_another_build_has_a_different_identity(self):
        before = self.identity()
        self.files["/sys/kernel/notes"] = note(b"GNU\0", bytes.fromhex("34" * 40))
        after = self.identity()
        self.assertEqual(before["kernel"]["release"], after["kernel"]["release"])
        self.assertNotEqual(before["kernel"]["buildId"], after["kernel"]["buildId"])
        self.assertNotEqual(before["kernel"]["notesSha256"], after["kernel"]["notesSha256"])

    def test_duplicate_missing_truncated_empty_and_oversized_notes_refuse(self):
        good = note(b"GNU\0", self.build_id)
        for raw in (good + good, note(b"Linux\0", b"fixture", 1), good[:-1], b"", b"\0" * 65537,
                    note(b"GNU\0", b""), note(b"GNU\0", b"x" * 257), struct.pack("<III", 0xffffffff, 1, 3)):
            with self.subTest(size=len(raw)):
                self.files["/sys/kernel/notes"] = raw
                with self.assertRaises(integrity.Failure): self.identity()

    def test_unknown_or_partial_security_controls_refuse(self):
        for name, bad in (
            ("/sys/kernel/security/lsm", b"capability,yama\n"),
            ("/sys/kernel/security/lsm", b"apparmor,apparmor\n"),
            ("/sys/module/apparmor/parameters/enabled", b"N\n"),
            ("/proc/sys/kernel/unprivileged_userns_clone", b"0\n"),
            ("/proc/sys/user/max_user_namespaces", b"0\n"),
            ("/proc/sys/kernel/seccomp/actions_avail", b"allow\n"),
            ("/sys/fs/cgroup/cgroup.controllers", b"cpu memory\n"),
            ("/proc/sys/kernel/osrelease", b"other\n"),
            ("/proc/sys/kernel/version", b"other\n"),
        ):
            with self.subTest(name=name):
                original = self.files[name]
                self.files[name] = bad
                with self.assertRaises(integrity.Failure): self.identity()
                self.files[name] = original

    def test_missing_measurement_architecture_or_unbounded_strings_refuse(self):
        for field, value in (("machine", "aarch64"), ("release", "x" * 257), ("version", "bad\nvalue")):
            with self.subTest(field=field):
                original = getattr(self.uname, field)
                setattr(self.uname, field, value)
                with self.assertRaises(integrity.Failure): self.identity()
                setattr(self.uname, field, original)
        del self.files["/sys/kernel/notes"]
        with self.assertRaises(integrity.Failure): self.identity()

    def test_feature_policy_changes_even_when_required_booleans_still_pass(self):
        before = self.identity()
        self.files["/proc/sys/user/max_user_namespaces"] = b"2048\n"
        after = self.identity()
        self.assertEqual(before["kernel"], after["kernel"])
        self.assertNotEqual(integrity.packed(before["features"]), integrity.packed(after["features"]))


class OriginalDescriptor(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.file = self.root / "sys/kernel/notes"
        self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b"fixture-notes")
        self.file.chmod(0o444)
        self.reader = integrity.KernelReader(self.root, uid=os.getuid(), gid=os.getgid(), filesystem_type=lambda _fd: 0x62656572)

    def tearDown(self): self.scratch.cleanup()

    def test_reads_an_original_bounded_descriptor(self):
        self.assertEqual(self.reader.read("/sys/kernel/notes", 64, 0x62656572), b"fixture-notes")

    def test_rejects_wrong_filesystem_special_file_mode_or_link(self):
        with self.assertRaises(integrity.Failure): self.reader.read("/sys/kernel/notes", 64, 0x9fa0)
        for mode in (0o446, 0o666):
            self.file.chmod(mode)
            with self.assertRaises(integrity.Failure): self.reader.read("/sys/kernel/notes", 64, 0x62656572)
        self.file.unlink()
        self.file.symlink_to("other")
        with self.assertRaises(integrity.Failure): self.reader.read("/sys/kernel/notes", 64, 0x62656572)
        self.file.unlink()
        os.mkfifo(self.file)
        with self.assertRaises(integrity.Failure): self.reader.read("/sys/kernel/notes", 64, 0x62656572)

    def test_rejects_read_overflow(self):
        with self.assertRaises(integrity.Failure): self.reader.read("/sys/kernel/notes", 2, 0x62656572)

    def test_rejects_path_replacement_after_open_without_reading_replacement(self):
        original_open = os.open
        descriptors = []
        def opened(name, flags, *args, **kwargs):
            fd = original_open(name, flags, *args, **kwargs)
            descriptors.append(fd)
            if name == "notes":
                self.file.rename(self.file.with_name("old"))
                self.file.write_bytes(b"replacement")
                self.file.chmod(0o444)
            return fd
        with patch.object(integrity.os, "open", side_effect=opened):
            with self.assertRaises(integrity.Failure): self.reader.read("/sys/kernel/notes", 64, 0x62656572)
        for fd in descriptors:
            with self.assertRaises(OSError): os.fstat(fd)


class StableInventory(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.uid, self.gid = os.getuid(), os.getgid()
        self.write("/opt/zeros-bootstrap/helper.py", b"verified helper\n", 0o555)
        self.write("/usr/lib/fixture.so", b"stock dependency\n", 0o444)
        (self.root / "lib").symlink_to("usr/lib")
        self.selectors = [{"path": "/opt/zeros-bootstrap", "recursive": True},
                          {"path": "/lib/fixture.so", "recursive": False},
                          {"path": "/etc/systemd/system/zeros-host.service.d", "recursive": True}]

    def tearDown(self): self.scratch.cleanup()

    def write(self, path, data, mode):
        file = self.root / path.lstrip("/")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        file.chmod(mode)
        return file

    def capture(self):
        return integrity.IntegrityInventory(self.root, uid=self.uid, gid=self.gid).capture(self.selectors)

    def verify(self, expected, digest=None):
        digest = digest or hashlib.sha256(integrity.packed(expected)).hexdigest()
        return integrity.verify_integrity_inventory(expected, digest, root=self.root, uid=self.uid, gid=self.gid)

    def test_captures_exact_bytes_aliases_modes_and_required_absence(self):
        expected = self.capture()
        self.assertEqual(expected["entries"]["/lib"], {"kind": "link", "uid": self.uid, "gid": self.gid, "mode": 0o777, "target": "usr/lib"})
        self.assertEqual(expected["entries"]["/usr/lib/fixture.so"]["sha256"], hashlib.sha256(b"stock dependency\n").hexdigest())
        self.assertEqual(expected["entries"]["/opt/zeros-bootstrap/helper.py"]["mode"], 0o555)
        self.assertEqual(expected["entries"]["/etc"], {"kind": "absent"})
        self.verify(expected)

    def test_rejects_content_tamper_even_when_size_and_mtime_match(self):
        expected = self.capture()
        file = self.root / "usr/lib/fixture.so"
        before = file.stat()
        file.chmod(0o644)
        file.write_bytes(b"stock dependencz\n")
        file.chmod(0o444)
        os.utime(file, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(file.stat().st_size, before.st_size)
        with self.assertRaises(integrity.Failure): self.verify(expected)

    def test_rejects_dependency_alias_and_protected_tree_additions(self):
        for alteration in ("alias", "mode", "new-helper", "override"):
            with self.subTest(alteration=alteration):
                expected = self.capture()
                if alteration == "alias":
                    (self.root / "lib").unlink()
                    (self.root / "lib").symlink_to("usr")
                elif alteration == "mode": (self.root / "usr/lib/fixture.so").chmod(0o644)
                elif alteration == "new-helper": self.write("/opt/zeros-bootstrap/extra.py", b"extra", 0o444)
                else: self.write("/etc/systemd/system/zeros-host.service.d/override.conf", b"override", 0o444)
                with self.assertRaises(integrity.Failure): self.verify(expected)
                if alteration == "alias":
                    (self.root / "lib").unlink()
                    (self.root / "lib").symlink_to("usr/lib")
                elif alteration == "mode": (self.root / "usr/lib/fixture.so").chmod(0o444)
                elif alteration == "new-helper": (self.root / "opt/zeros-bootstrap/extra.py").unlink()

    def test_ignores_unselected_user_state_and_does_not_emit_bytes_or_inodes(self):
        expected = self.capture()
        self.write("/home/fixture/project/user-file", b"synthetic private user data", 0o600)
        self.verify(expected)
        encoded = integrity.packed(expected)
        self.assertNotIn(b"synthetic private", encoded)
        self.assertNotIn(b"verified helper", encoded)
        self.assertNotIn(b"mtime", encoded)
        self.assertNotIn(b"inode", encoded)

    def test_requires_external_digest_and_closed_inventory(self):
        expected = self.capture()
        with self.assertRaises(integrity.Failure): self.verify(expected, "0" * 64)
        expected["unexpected"] = "synthetic private"
        with self.assertRaises(integrity.Failure): self.verify(expected)

    def test_rejects_hard_links_writable_parent_and_forbidden_xattrs(self):
        os.link(self.root / "usr/lib/fixture.so", self.root / "usr/lib/second.so")
        with self.assertRaises(integrity.Failure): self.capture()
        (self.root / "usr/lib/second.so").unlink()
        (self.root / "usr/lib").chmod(0o777)
        with self.assertRaises(integrity.Failure): self.capture()
        (self.root / "usr/lib").chmod(0o755)
        with patch.object(integrity.os, "listxattr", return_value=["security.capability"]):
            with self.assertRaises(integrity.Failure): self.capture()

    def test_rejects_opened_replacement_and_closes_its_descriptors(self):
        original_open = os.open
        descriptors = []
        def opened(name, flags, *args, **kwargs):
            fd = original_open(name, flags, *args, **kwargs)
            descriptors.append(fd)
            if name == "fixture.so":
                file = self.root / "usr/lib/fixture.so"
                file.rename(file.with_name("old.so"))
                self.write("/usr/lib/fixture.so", b"replacement", 0o444)
            return fd
        with patch.object(integrity.os, "open", side_effect=opened):
            with self.assertRaises(integrity.Failure): self.capture()
        for fd in descriptors:
            with self.assertRaises(OSError): os.fstat(fd)

    def test_bounds_complete_inventory_instead_of_truncating_it(self):
        with patch.object(integrity, "INVENTORY_MAX_ENTRIES", 3):
            with self.assertRaises(integrity.Failure): self.capture()
        with patch.object(integrity, "INTEGRITY_MAX_BYTES", 100):
            with self.assertRaises(integrity.Failure): self.capture()

    def test_complete_python_sized_inventory_is_not_limited_to_a_small_manifest(self):
        directory = self.root / "usr/lib/python3.12/fixture"
        directory.mkdir(parents=True)
        for index in range(3072):
            (directory / ("module_%04d.py" % index)).write_bytes(b"# fixed fixture\n")
        self.selectors.append({"path": "/usr/lib/python3.12", "recursive": True})
        value = self.capture()
        self.assertEqual(len([name for name in value["entries"] if name.endswith(".py")]), 3073)
        self.assertGreater(len(integrity.packed(value)), 256 * 1024)
        self.verify(value)

    def test_directory_acl_added_after_last_metadata_read_refuses_and_unwinds(self):
        target = self.root / "usr/lib"
        original_read, original_xattrs, original_open = os.read, os.listxattr, os.open
        inserted, descriptors = [], []
        def opened(*args, **kwargs):
            fd = original_open(*args, **kwargs); descriptors.append(fd); return fd
        def read(fd, maximum):
            raw = original_read(fd, maximum)
            if os.readlink("/proc/self/fd/" + str(fd)) == str(target / "fixture.so"):
                inserted.append(True)
            return raw
        def xattrs(fd):
            if inserted and os.readlink("/proc/self/fd/" + str(fd)) == str(target):
                return ["system.posix_acl_default"]
            return original_xattrs(fd)
        # Exercise a single production path read, so a later whole-inventory
        # pass cannot mask the stale last-ACL-read window.
        with patch.object(integrity.os, "read", side_effect=read), \
                patch.object(integrity.os, "listxattr", side_effect=xattrs), \
                patch.object(integrity.os, "open", side_effect=opened):
            with self.assertRaises(integrity.Failure):
                integrity.IntegrityInventory(self.root, uid=self.uid, gid=self.gid)._read("/usr/lib/fixture.so", False)
        self.assertTrue(inserted)
        for fd in descriptors:
            with self.assertRaises(OSError): os.fstat(fd)

    def test_aggregate_read_budget_is_enforced_without_returning_a_partial_inventory(self):
        with patch.object(integrity, "INVENTORY_MAX_READ_BYTES", 16, create=True):
            with self.assertRaises(integrity.Failure): self.capture()

    def test_rechecks_even_an_empty_protected_directory_after_enumeration(self):
        empty = self.root / "opt/zeros-bootstrap/empty"
        empty.mkdir()
        original_listdir = os.listdir
        reads = 0
        def listed(fd):
            nonlocal reads
            result = original_listdir(fd)
            if isinstance(fd, int) and os.readlink("/proc/self/fd/" + str(fd)) == str(empty):
                reads += 1
                if reads == 2:
                    self.write("/opt/zeros-bootstrap/empty/late.py", b"late", 0o444)
            return result
        with patch.object(integrity.os, "listdir", side_effect=listed):
            with self.assertRaises(integrity.Failure): self.capture()

    def test_pins_protected_principals_without_hashing_unrelated_account_additions(self):
        passwd = b"root:x:0:0:root:/root:/bin/bash\nzeros-engine:x:10003:10003::/nonexistent:/usr/sbin/nologin\n"
        self.write("/etc/passwd", passwd, 0o644)
        self.selectors.append({"path": "/etc/passwd", "recursive": False})
        expected = self.capture()
        self.write("/etc/passwd", passwd + b"package-user:x:15000:15000::/nonexistent:/usr/sbin/nologin\n", 0o644)
        self.verify(expected)
        self.assertNotIn(b"root:x", integrity.packed(expected))
        self.assertNotIn(b"package-user", integrity.packed(expected))
        self.write("/etc/passwd", passwd + b"alias:x:10003:10003::/nonexistent:/usr/sbin/nologin\n", 0o644)
        with self.assertRaises(integrity.Failure): self.verify(expected)

    def test_pins_subordinate_ranges_that_overlap_any_protected_identity(self):
        original = b"zeros-agent:100000:65536\n"
        self.write("/etc/subuid", original, 0o644)
        self.selectors.append({"path": "/etc/subuid", "recursive": False})
        expected = self.capture()
        self.write("/etc/subuid", original + b"package-user:200000:65536\n", 0o644)
        self.verify(expected)
        self.write("/etc/subuid", original + b"alias:9999:6\n", 0o644)
        with self.assertRaises(integrity.Failure): self.verify(expected)


class FixedClosure(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.uid, self.gid = os.getuid(), os.getgid()
        self.write("/opt/zeros-bootstrap/bootstrap.py", b"base verifier", 0o555)
        self.write("/etc/zeros/cloud-worker.json", b"{}")
        self.write("/usr/bin/python3.12", b"fixed interpreter", 0o555)
        self.write("/usr/bin/ldd", b"fixed dependency reader", 0o555)
        self.write("/usr/lib/fixture.so", b"fixed dependency")
        self.write("/usr/lib/python3.12/importlib/__init__.py", b"fixed loader")
        self.write("/etc/systemd/system/zeros-host.service", b"fixed host unit")
        self.write("/etc/systemd/system/unrelated.service", b"unrelated unit")
        self.write("/etc/passwd", b"root:x:0:0:root:/root:/bin/bash\n")
        self.stock = {"schema": "zeros.stock-prerequisites/v1",
                      "binaries": {"/usr/bin/python3.12": {"path": "/usr/bin/python3.12", "sha256": hashlib.sha256(b"fixed interpreter").hexdigest()}},
                      "libraries": {"fixture.so": {"path": "/usr/lib/fixture.so", "sha256": hashlib.sha256(b"fixed dependency").hexdigest()}}}
        self.compatibility = {"protectedFiles": [{"path": "/opt/zeros-bootstrap/bootstrap.py"}]}
        self.dependencies = ["/usr/lib/fixture.so"]

    def tearDown(self): self.scratch.cleanup()

    def write(self, name, raw, mode=0o444):
        target = self.root / name.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        # Tamper only with owned synthetic bytes; restore the protected mode
        # even when the runner has no DAC override capability.
        if target.exists(): target.chmod(0o600)
        try: target.write_bytes(raw)
        finally: target.chmod(mode)
        return target

    def capture(self):
        return integrity.capture_protected_closure(self.compatibility, self.stock, self.dependencies,
            root=self.root, uid=self.uid, gid=self.gid)

    def verify(self, original):
        return integrity.verify_protected_closure(original, root=self.root, uid=self.uid, gid=self.gid)

    def test_fixed_closure_protects_verifier_dependencies_interpreter_and_service_policy(self):
        value = self.capture()
        entries = value["inventory"]["entries"]
        for name in ("/opt/zeros-bootstrap/bootstrap.py", "/usr/lib/fixture.so",
                     "/usr/lib/python3.12/importlib/__init__.py", "/etc/systemd/system/zeros-host.service"):
            self.assertIn(name, entries)
        self.assertNotIn("/etc/systemd/system/unrelated.service", entries)
        self.assertNotIn("/srv/zeros/state", entries)
        self.verify(value)

    def test_new_service_override_and_loader_inputs_are_not_unrelated_package_additions(self):
        for name in ("/etc/systemd/system/new.target.wants/zeros-host.service",
                     "/run/systemd/generator.early/zeros-host.service",
                     "/etc/systemd/system/service.d/new.conf", "/etc/ld.so.preload"):
            with self.subTest(name=name):
                original = self.capture()
                target = self.write(name, b"new loader input")
                with self.assertRaises(integrity.Failure): self.verify(original)
                target.unlink()

    def test_unrelated_service_and_workspace_changes_do_not_change_protected_selection(self):
        original = self.capture()
        self.write("/etc/systemd/system/another.service", b"unrelated addition")
        self.write("/etc/systemd/system/other\\x2dservice.service", b"unrelated escaped name")
        self.write("/srv/zeros/state/private.json", b"synthetic private state", 0o600)
        self.write("/srv/zeros/files/repos/project/user.py", b"mutable repository", 0o644)
        self.verify(original)

    def test_python_site_startup_inputs_are_part_of_the_protected_closure(self):
        original = self.capture()
        self.write("/usr/local/lib/python3.12/dist-packages/sitecustomize.py", b"startup code")
        with self.assertRaises(integrity.Failure): self.verify(original)

    def provider_ownership(self, extra=()):
        """Model only ownership; all reads, directory walks and modes are real."""
        provider = {"uid": 15001, "gid": 15002}
        self.stock["optionalSystemd"] = {"provider": provider}
        paths = {str(self.root / name.lstrip("/")) for name in ("/usr/local", "/usr/local/lib", *extra)}
        original_stat, original_fstat = os.stat, os.fstat
        def changed(info, name):
            if str(name) not in paths: return info
            result = types.SimpleNamespace(**{key: getattr(info, key) for key in dir(info) if key.startswith("st_")})
            result.st_uid, result.st_gid = provider["uid"], provider["gid"]
            return result
        def statted(name, *args, **kwargs):
            full = Path(os.readlink("/proc/self/fd/" + str(kwargs["dir_fd"]))) / name if "dir_fd" in kwargs else name
            return changed(original_stat(name, *args, **kwargs), full)
        def fstatted(fd):
            return changed(original_fstat(fd), os.readlink("/proc/self/fd/" + str(fd)))
        return patch.object(integrity.os, "stat", side_effect=statted), patch.object(integrity.os, "fstat", side_effect=fstatted)

    def test_pinned_provider_pair_applies_only_to_two_fixed_directory_ancestors(self):
        target = self.write("/usr/local/lib/python3.12/site-packages/fixed.py", b"fixed startup")
        stat_patch, fstat_patch = self.provider_ownership()
        with stat_patch, fstat_patch:
            value = self.capture()
            self.assertEqual(value["inventory"]["provider"], self.stock["optionalSystemd"]["provider"])
            self.verify(value)
            self.assertEqual(integrity.elf_prefix("/usr/local/lib/python3.12/site-packages/fixed.py",
                root=self.root, uid=self.uid, gid=self.gid, provider=value["inventory"]["provider"]), b"fixed startup")
            self.stock["optionalSystemd"]["provider"] = {"uid": 15003, "gid": 15004}
            with self.assertRaises(integrity.Failure): self.capture()
        stat_patch, fstat_patch = self.provider_ownership(("/usr/local/lib/python3.12",))
        with stat_patch, fstat_patch:
            with self.assertRaises(integrity.Failure): self.capture()
        self.assertEqual(target.read_bytes(), b"fixed startup")

    def test_provider_ancestry_does_not_authorize_symlinks_modes_or_acl(self):
        local = self.root / "usr/local/lib"
        local.mkdir(parents=True)
        stat_patch, fstat_patch = self.provider_ownership()
        with stat_patch, fstat_patch:
            value = self.capture()
            self.assertEqual(value["inventory"]["entries"]["/usr/local/lib/python3.12"], {"kind": "absent"})
            local.chmod(0o777)
            with self.assertRaises(integrity.Failure): self.capture()
            local.chmod(0o755)
            original_xattrs = os.listxattr
            def xattrs(fd):
                return ["system.posix_acl_default"] if os.readlink("/proc/self/fd/" + str(fd)) == str(local) else original_xattrs(fd)
            with patch.object(integrity.os, "listxattr", side_effect=xattrs):
                with self.assertRaises(integrity.Failure): self.capture()
        local.rmdir(); local.symlink_to("../lib")
        with self.assertRaises(integrity.Failure): self.capture()

    def test_fixed_policy_refuses_secret_or_user_paths_from_dependency_discovery(self):
        for name in ("/root/.ssh/private", "/srv/zeros/state/credentials.json", "/home/user/.env", "/etc/shadow"):
            with self.subTest(name=name):
                self.dependencies = [name]
                with self.assertRaises(integrity.Failure): self.capture()

    def test_dependency_bytes_and_full_interpreter_closure_are_rechecked(self):
        for name in ("/usr/lib/fixture.so", "/usr/lib/python3.12/importlib/__init__.py"):
            with self.subTest(name=name):
                original = self.capture()
                before = (self.root / name.lstrip("/")).read_bytes()
                self.write(name, b"replacement")
                with self.assertRaises(integrity.Failure): self.verify(original)
                self.write(name, before)

    def test_only_original_build_install_unit_is_excluded_from_stable_policy(self):
        build_id = "11111111-1111-4111-8111-111111111111"
        name = "/run/systemd/transient/zeros-computer-install-" + build_id + ".service"
        self.write(name, b"current recipe unit")
        value = integrity.capture_protected_closure(self.compatibility, self.stock, self.dependencies,
            root=self.root, uid=self.uid, gid=self.gid, build_id=build_id)
        self.assertNotIn(name, value["systemdPaths"])
        integrity.verify_protected_closure(value, root=self.root, uid=self.uid, gid=self.gid, build_id=build_id)
        self.write("/run/systemd/transient/zeros-computer-install-22222222-2222-4222-8222-222222222222.service", b"foreign")
        with self.assertRaises(integrity.Failure):
            integrity.verify_protected_closure(value, root=self.root, uid=self.uid, gid=self.gid, build_id=build_id)


class DependencyDiscovery(unittest.TestCase):
    def test_prefix_reader_rejects_unprotected_root_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "usr/bin/fixture"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"fixed binary")
            binary.chmod(0o555)
            root.chmod(0o777)
            try:
                with self.assertRaises(integrity.Failure):
                    integrity.elf_prefix("/usr/bin/fixture", root=root, uid=os.getuid(), gid=os.getgid())
            finally: root.chmod(0o700)

    def test_disappeared_systemd_parent_is_not_a_qualified_absence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            surface = root / "etc/systemd/system"
            surface.mkdir(parents=True)
            original_open = os.open
            removed = []
            def opened(name, flags, *args, **kwargs):
                if name == "system" and not removed:
                    surface.rmdir()
                    removed.append(True)
                return original_open(name, flags, *args, **kwargs)
            with patch.object(integrity.os, "open", side_effect=opened):
                with self.assertRaises(integrity.Failure):
                    integrity.systemd_paths(root=root, uid=os.getuid(), gid=os.getgid())
            self.assertEqual(removed, [True])

    def test_parses_only_complete_loader_results_and_refuses_missing_dependencies(self):
        raw = b"\tlinux-vdso.so.1 (0x7ff00000)\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x7ff10000)\n\t/lib64/ld-linux-x86-64.so.2 (0x7ff20000)\n"
        self.assertEqual(integrity.parse_loader_dependencies(raw),
                         ["/lib/x86_64-linux-gnu/libc.so.6", "/lib64/ld-linux-x86-64.so.2"])
        for invalid in (b"libmissing.so => not found\n", b"untrusted diagnostic\n", b"", b"x" * 65537):
            with self.subTest(invalid=invalid[:32]):
                with self.assertRaises(integrity.Failure): integrity.parse_loader_dependencies(invalid)

    def test_static_elf_has_no_loader_and_truncated_or_wrong_arch_elf_refuses(self):
        header = bytearray(120)
        header[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", header, 18, 62)
        struct.pack_into("<Q", header, 32, 64)
        struct.pack_into("<H", header, 54, 56)
        struct.pack_into("<H", header, 56, 1)
        struct.pack_into("<I", header, 64, 1)
        self.assertFalse(integrity.elf_has_loader(bytes(header)))
        struct.pack_into("<I", header, 64, 2)
        self.assertTrue(integrity.elf_has_loader(bytes(header)))
        self.assertIsNone(integrity.elf_has_loader(b"#!/bin/sh\n"))
        for invalid in (bytes(header[:70]), b"\x7fELF", bytes(header[:18]) + b"\x03\x00" + bytes(header[20:])):
            with self.assertRaises(integrity.Failure): integrity.elf_has_loader(invalid)


if __name__ == "__main__": unittest.main()
