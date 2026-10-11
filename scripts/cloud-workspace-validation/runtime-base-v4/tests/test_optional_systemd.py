"""Qualified absence is narrower than ownership of an actual protected file."""
import copy
import importlib.util
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / "bootstrap.py"
spec = importlib.util.spec_from_file_location("absence_bootstrap", SOURCE)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
SURFACE = "/usr/local/lib/systemd/system"


class OptionalSystemdTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local = self.root / "usr/local"
        (self.local / "lib").mkdir(parents=True)
        self.app = b.Bootstrap(self.root, uid=os.getuid(), gid=os.getgid())
        self.provider = {"uid": 4242, "gid": 4242}
        self.owners = {self.local: (4242, 4242), self.local / "lib": (4242, 4242)}
        original_stat, original_fstat = os.stat, os.fstat

        def metadata(value, path):
            if path not in self.owners:
                return value
            fields = {name: getattr(value, name) for name in dir(value) if name.startswith("st_")}
            fields["st_uid"], fields["st_gid"] = self.owners[path]
            return types.SimpleNamespace(**fields)

        def file_stat(path, *args, **kwargs):
            value = original_stat(path, *args, **kwargs)
            absolute = Path(path)
            if kwargs.get("dir_fd") is not None:
                absolute = Path(os.readlink("/proc/self/fd/" + str(kwargs["dir_fd"]))) / absolute
            return metadata(value, absolute)

        def fd_stat(fd):
            return metadata(original_fstat(fd), Path(os.readlink("/proc/self/fd/" + str(fd))))

        self.addCleanup(mock.patch.stopall)
        mock.patch.object(b.os, "stat", side_effect=file_stat).start()
        mock.patch.object(b.os, "fstat", side_effect=fd_stat).start()

    def qualify(self):
        return self.app.qualify_optional_systemd(self.provider)

    def verify(self, policy):
        return self.app.optional_systemd_absence(policy)

    def test_stock_provider_owned_ancestors_need_sealed_qualification(self):
        policy = self.qualify()
        snapshot = self.verify(policy)
        self.assertEqual(snapshot, policy["snapshot"])
        self.assertEqual(snapshot["ancestors"]["/usr/local"]["uid"], 4242)
        self.assertEqual(snapshot["ancestors"]["/usr/local"]["acl"], [])
        self.assertEqual(snapshot["absent"], "/usr/local/lib/systemd")
        for unqualified in (None, {}, {"snapshot": snapshot}, {**policy, "schema": "unknown"}):
            with self.subTest(policy=unqualified), self.assertRaises(b.Failure):
                self.verify(unqualified)

    def test_new_systemd_surface_or_protected_entries_are_not_new_qualification(self):
        policy = self.qualify()
        surface = self.root / SURFACE.lstrip("/")
        surface.mkdir(parents=True)
        with self.assertRaises(b.Failure): self.verify(policy)
        policy = self.qualify()
        for relative in ("zeros-host.service", "zeros-boot.service.d", "service.d", "nested/zeros-host.service", "nested/service.d"):
            with self.subTest(relative=relative):
                target = surface / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("override")
                with self.assertRaises(b.Failure): self.verify(policy)
                with self.assertRaises(b.Failure): self.qualify()
                target.unlink()
                if target.parent != surface: target.parent.rmdir()

    def test_unrelated_file_under_existing_surface_is_allowed(self):
        surface = self.root / SURFACE.lstrip("/")
        surface.mkdir(parents=True)
        policy = self.qualify()
        (surface / "unrelated.service").write_text("[Unit]\nDescription=fixture\n")
        self.verify(policy)

    def test_symlink_at_each_optional_component_is_rejected(self):
        surface = self.root / SURFACE.lstrip("/")
        surface.mkdir(parents=True)
        policy = self.qualify()
        for relative in ("usr", "usr/local", "usr/local/lib", "usr/local/lib/systemd", "usr/local/lib/systemd/system"):
            with self.subTest(relative=relative):
                target = self.root / relative
                saved = target.with_name(target.name + "-saved")
                target.rename(saved)
                target.symlink_to(saved, target_is_directory=True)
                try:
                    with self.assertRaises(b.Failure): self.verify(policy)
                finally:
                    target.unlink()
                    saved.rename(target)
        (surface / "unrelated-link").symlink_to(self.local)
        with self.assertRaises(b.Failure): self.verify(policy)

    def test_modes_owner_changes_and_zeros_principals_are_rejected(self):
        policy = self.qualify()
        for owner in ((4243, 4242), (4242, 4243), (0, 0), (10003, 10003), (10001, 10001)):
            self.owners[self.local] = owner
            with self.subTest(owner=owner), self.assertRaises(b.Failure): self.verify(policy)
        self.owners[self.local] = (4242, 4242)
        for mode in (0o775, 0o777, 0o700, 0o2755):
            self.local.chmod(mode)
            with self.subTest(mode=mode), self.assertRaises(b.Failure): self.verify(policy)
        self.local.chmod(0o755)
        for provider in ({"uid": 10003, "gid": 10003}, {"uid": 10001, "gid": 10001}, {"uid": 0, "gid": 0}):
            with self.subTest(provider=provider), self.assertRaises(b.Failure): self.app.qualify_optional_systemd(provider)

    def test_acl_access_default_and_capability_attributes_fail_closed(self):
        policy = self.qualify()
        for attribute in ("system.posix_acl_access", "system.posix_acl_default", "security.capability"):
            with self.subTest(attribute=attribute), mock.patch.object(b.os, "listxattr", return_value=[attribute]):
                with self.assertRaises(b.Failure): self.verify(policy)
                with self.assertRaises(b.Failure): self.qualify()

    def test_new_mount_on_same_filesystem_is_rejected(self):
        policy = self.qualify()
        original = self.app.mounts.mount_id
        def redirected(fd):
            return original(fd) + (1 if Path(os.readlink("/proc/self/fd/" + str(fd))) == self.local else 0)
        with mock.patch.object(self.app.mounts, "mount_id", side_effect=redirected):
            with self.assertRaises(b.Failure): self.verify(policy)

    def test_late_bind_of_same_inode_is_reopened_and_rejected(self):
        policy = self.qualify()
        original = os.open
        original_mount = self.app.mounts.mount_id
        opens, redirected = 0, set()
        def replaced(path, flags, *args, **kwargs):
            nonlocal opens
            fd = original(path, flags, *args, **kwargs)
            if Path(os.readlink("/proc/self/fd/" + str(fd))) == self.local:
                opens += 1
                if opens > 1: redirected.add(fd)
            return fd
        with mock.patch.object(b.os, "open", side_effect=replaced), \
                mock.patch.object(self.app.mounts, "mount_id", side_effect=lambda fd: original_mount(fd) + (1 if fd in redirected else 0)):
            with self.assertRaises(b.Failure): self.verify(policy)

    def test_inode_replacement_during_a_pass_is_rejected(self):
        surface = self.root / SURFACE.lstrip("/")
        surface.mkdir(parents=True)
        policy = self.qualify()
        original = os.listdir
        swapped = False
        def replaced(fd):
            nonlocal swapped
            result = original(fd)
            if not swapped:
                swapped = True
                surface.rename(surface.with_name("retired"))
                surface.mkdir()
            return result
        with mock.patch.object(b.os, "listdir", side_effect=replaced):
            with self.assertRaises(b.Failure): self.verify(policy)

    def test_cold_boot_compares_policy_not_inode_numbers(self):
        surface = self.root / SURFACE.lstrip("/")
        surface.mkdir(parents=True)
        policy = self.qualify()
        old_inode = surface.stat().st_ino
        saved = surface.with_name("retired")
        surface.rename(saved)
        surface.mkdir()
        self.assertNotEqual(surface.stat().st_ino, old_inode)
        self.assertEqual(self.verify(policy), policy["snapshot"])
        shutil.rmtree(saved)
        self.assertEqual(self.verify(copy.deepcopy(policy)), policy["snapshot"])


if __name__ == "__main__":
    unittest.main()
