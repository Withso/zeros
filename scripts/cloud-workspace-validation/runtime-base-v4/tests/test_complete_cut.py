"""Real filesystem oracle for immutable raw cuts; not kernel qualification."""
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "complete_cut.py"
c = None
if SOURCE.exists():
    spec = importlib.util.spec_from_file_location("complete_cut", SOURCE)
    c = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c)


class RawCutTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(c, "complete immutable staging must exist before enrollment")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir(mode=0o700)
        self.target = self.root / "stage"
        self.target.mkdir(mode=0o700)
        self.source_fd = os.open(self.source, os.O_RDONLY | os.O_DIRECTORY)
        self.target_fd = os.open(self.target, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.source_fd)
        self.addCleanup(os.close, self.target_fd)
        # Explicit test limits, not measured production pause/transfer budgets.
        self.limits = {"maxEntries": 1000, "maxBytes": 32 * 1024 * 1024,
                       "readBytes": 64 * 1024, "maxMetadataBytes": 128 * 1024}

    def capture(self, guard=lambda: None):
        return c.stage_raw_cut({"files": self.source_fd}, self.target_fd,
                               self.limits, guard, {os.getuid()}, {os.getgid()})

    def read(self, relative):
        return c.read_raw_file(self.target_fd, "files", relative, lambda: None)

    def test_complete_inventory_keeps_private_ignored_dependencies_and_empty_directories(self):
        expected = {".env": b"fixture-user-authored-secret", "node_modules/modified/index.js": b"modified",
                    ".git/objects/private-object": b"git-history", ".context/notes": b"private",
                    "home/.ssh/key": b"fixture-private-user-key", "ordinary": b"file"}
        for name, value in expected.items():
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(value)
        (self.source / "empty").mkdir()
        result = self.capture()
        self.assertEqual(result["kind"], "private-raw-cut")
        self.assertFalse("receipt" in result)
        for name, value in expected.items():
            self.assertEqual(self.read(name), value)
        entries = c.read_raw_inventory(self.target_fd, lambda: None)
        self.assertIn(("empty", "directory"), [(entry["path"], entry["kind"]) for entry in entries])

    def test_sparse_lengths_extents_modes_times_and_xattrs_survive(self):
        file = self.source / "sparse"
        with file.open("wb") as handle:
            handle.write(b"prefix")
            handle.seek(4 * 1024 * 1024)
            handle.write(b"suffix")
        os.chmod(file, 0o640)
        os.utime(file, ns=(1234567890000000000, 1234567890123456789))
        os.setxattr(file, "user.complete-cut", b"retained")
        self.capture()
        self.assertEqual(self.read("sparse"), file.read_bytes())
        entry = next(entry for entry in c.read_raw_inventory(self.target_fd, lambda: None) if entry["path"] == "sparse")
        self.assertEqual(entry["mode"], 0o640)
        self.assertEqual(entry["mtimeNs"], 1234567890123456789)
        self.assertIn("user.complete-cut", entry["xattrs"])
        self.assertLess(sum(extent["bytes"] for extent in entry["extents"]), entry["bytes"])

    def test_inside_hardlinks_and_contained_links_are_preserved(self):
        (self.source / "first").write_bytes(b"same-inode")
        os.link(self.source / "first", self.source / "second")
        (self.source / "link").symlink_to("second")
        self.capture()
        entries = {entry["path"]: entry for entry in c.read_raw_inventory(self.target_fd, lambda: None)}
        self.assertEqual(entries["second"]["kind"], "hardlink")
        self.assertEqual(entries["second"]["target"], {"root": "files", "path": "first"})
        self.assertEqual(entries["link"]["target"], "second")
        self.assertEqual(self.read("second"), b"same-inode")

    def test_external_hardlink_refuses_the_whole_cut(self):
        (self.source / "inside").write_bytes(b"outside-dependency")
        os.link(self.source / "inside", self.root / "outside")
        with self.assertRaises(c.CutRefused): self.capture()
        self.assertFalse((self.target / "manifest.json").exists())

    def test_escaping_dangling_and_looping_links_refuse(self):
        for target in ("../outside", "/etc/passwd", "missing", "link"):
            with self.subTest(target=target):
                link = self.source / "link"
                link.symlink_to(target)
                with self.assertRaises(c.CutRefused): self.capture()
                self.assertFalse((self.target / "manifest.json").exists())
                link.unlink()
                for file in self.target.iterdir(): file.unlink()

    def test_devices_fifos_privileged_modes_and_unknown_metadata_refuse(self):
        file = self.source / "special"
        os.mkfifo(file)
        with self.assertRaises(c.CutRefused): self.capture()
        file.unlink(); file.write_bytes(b"user")
        os.chmod(file, 0o4600)
        with self.assertRaises(c.CutRefused): self.capture()
        self.assertFalse((self.target / "manifest.json").exists())

    def test_post_cut_edits_and_deletion_do_not_change_the_original_copy(self):
        file = self.source / "data"
        file.write_bytes(b"cut")
        self.capture()
        file.write_bytes(b"after-cut")
        self.assertEqual(self.read("data"), b"cut")
        file.unlink()
        self.assertEqual(self.read("data"), b"cut")
        # A second full inventory represents deletion, not an overlay.
        second = self.root / "next"; second.mkdir(mode=0o700)
        fd = os.open(second, os.O_RDONLY | os.O_DIRECTORY)
        try:
            c.stage_raw_cut({"files": self.source_fd}, fd, self.limits, lambda: None, {os.getuid()}, {os.getgid()})
            self.assertEqual([entry["path"] for entry in c.read_raw_inventory(fd, lambda: None)], [""])
        finally: os.close(fd)

    def test_original_removed_still_reads_and_detects_any_corrupt_payload(self):
        file = self.source / "data"; file.write_bytes(b"complete")
        self.capture(); file.unlink(); self.source.rmdir()
        self.assertEqual(self.read("data"), b"complete")
        payload = next(self.target.glob("*.data"))
        payload.write_bytes(b"corrupt!")
        with self.assertRaises(c.CutRefused): self.read("data")

    def test_self_contained_git_history_stash_index_and_private_work_survive_original_removal(self):
        empty = self.root / "empty-template"; empty.mkdir()
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                       "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1", "GIT_ALLOW_PROTOCOL": ""}
        def git(directory, *args):
            result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture",
                                     "-c", "user.email=fixture@example.invalid", *args], cwd=directory,
                                    env=environment, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, "local Git oracle failed")
            return result.stdout
        git(self.source, "init", "--template=" + str(empty), "-b", "main")
        (self.source / "tracked").write_bytes(b"original history\n")
        git(self.source, "add", "tracked"); git(self.source, "commit", "-m", "fixture")
        (self.source / "tracked").write_bytes(b"stashed change\n"); git(self.source, "stash", "push", "-m", "fixture stash")
        (self.source / "tracked").write_bytes(b"staged change\n"); git(self.source, "add", "tracked")
        (self.source / "tracked").write_bytes(b"unstaged change\n")
        (self.source / ".env").write_bytes(b"fixture-user-private\n")
        head, stash = git(self.source, "rev-parse", "HEAD"), git(self.source, "rev-parse", "refs/stash")
        index, log = git(self.source, "ls-files", "--stage"), git(self.source, "reflog", "--all", "--format=%H")
        self.capture(); shutil.rmtree(self.source)
        restored = self.root / "restored"; restored.mkdir(mode=0o700)
        fd = os.open(restored, os.O_RDONLY | os.O_DIRECTORY)
        try: c.materialize_raw_cut(self.target_fd, fd, lambda: None, {os.getuid()}, {os.getgid()})
        finally: os.close(fd)
        repository = restored / "files"
        self.assertEqual(git(repository, "rev-parse", "HEAD"), head)
        self.assertEqual(git(repository, "rev-parse", "refs/stash"), stash)
        self.assertEqual(git(repository, "ls-files", "--stage"), index)
        self.assertEqual(git(repository, "reflog", "--all", "--format=%H"), log)
        self.assertEqual(git(repository, "show", "HEAD:tracked"), b"original history\n")
        self.assertEqual(git(repository, "show", ":tracked"), b"staged change\n")
        self.assertEqual((repository / "tracked").read_bytes(), b"unstaged change\n")
        self.assertEqual((repository / ".env").read_bytes(), b"fixture-user-private\n")
        git(repository, "fsck", "--full", "--strict")

    def test_no_final_manifest_after_cancellation_or_an_incomplete_write(self):
        (self.source / "data").write_bytes(b"content" * 100)
        calls = 0
        def guard():
            nonlocal calls
            calls += 1
            if calls > 4: raise c.CutRefused("deadline")
        with self.assertRaises(c.CutRefused): self.capture(guard)
        self.assertFalse((self.target / "manifest.json").exists())
        for file in self.target.iterdir(): file.unlink()
        real_write = os.write
        def failed_write(fd, value):
            if os.fstat(fd).st_mode & 0o170000 == stat.S_IFREG:
                raise OSError(errno.ENOSPC, "fixture private details")
            return real_write(fd, value)
        with mock.patch.object(c.os, "write", side_effect=failed_write):
            with self.assertRaises(c.CutRefused): self.capture()
        self.assertFalse((self.target / "manifest.json").exists())

    def test_mutating_a_file_or_directory_during_staging_refuses(self):
        file = self.source / "data"; file.write_bytes(b"original")
        original = os.read
        changed = False
        def read(fd, size):
            nonlocal changed
            result = original(fd, size)
            if not changed and result == b"original":
                changed = True; file.write_bytes(b"changed!")
            return result
        with mock.patch.object(c.os, "read", side_effect=read):
            with self.assertRaises(c.CutRefused): self.capture()
        self.assertTrue(changed)
        self.assertFalse((self.target / "manifest.json").exists())

    def test_attempt_limits_refuse_instead_of_publishing_a_partial_cut(self):
        (self.source / "one").write_bytes(b"one")
        (self.source / "two").write_bytes(b"two")
        self.limits["maxEntries"] = 1
        with self.assertRaises(c.CutRefused): self.capture()
        self.assertFalse((self.target / "manifest.json").exists())

    def test_final_directory_sync_and_guard_follow_manifest_publication(self):
        (self.source / "data").write_bytes(b"cut")
        seen = []
        real_sync = os.fsync
        def sync(fd):
            if (self.target / "manifest.json").exists(): seen.append("sync")
            real_sync(fd)
        def guard():
            if (self.target / "manifest.json").exists(): seen.append("guard")
        with mock.patch.object(c.os, "fsync", side_effect=sync): self.capture(guard)
        self.assertEqual(seen[-2:], ["sync", "guard"])

    def test_an_existing_stage_cannot_be_reused_for_a_successor(self):
        (self.source / "data").write_bytes(b"first")
        self.capture()
        before = (self.target / "manifest.json").read_bytes()
        with self.assertRaises(c.CutRefused): self.capture()
        self.assertEqual((self.target / "manifest.json").read_bytes(), before)

    def rewrite_inventory(self, change):
        inventory = self.target / "inventory.jsonl"
        rows = [json.loads(line) for line in inventory.read_bytes().splitlines()]
        change(rows)
        content = b"".join(c.packed(row) + b"\n" for row in rows)
        inventory.write_bytes(content)
        manifest = self.target / "manifest.json"
        value = json.loads(manifest.read_bytes())
        value.update(inventoryBytes=len(content), inventorySha256=hashlib.sha256(content).hexdigest())
        manifest.write_bytes(c.packed(value))

    def test_raw_manifest_version_is_an_exact_integer(self):
        (self.source / "data").write_bytes(b"kept"); self.capture()
        file = self.target / "manifest.json"; manifest = json.loads(file.read_bytes()); manifest["version"] = True
        file.write_bytes(c.packed(manifest))
        with self.assertRaises(c.CutRefused): c.read_manifest(self.target_fd, lambda: None)

    def test_rehashed_inventory_cannot_smuggle_unsupported_metadata_or_paths(self):
        (self.source / "data").write_bytes(b"kept")
        self.capture()
        original_inventory = (self.target / "inventory.jsonl").read_bytes()
        original_manifest = (self.target / "manifest.json").read_bytes()
        changes = [lambda rows: rows[1].update(extra="unknown"),
                   lambda rows: rows[1].update(mode=0o4600),
                   lambda rows: rows[1].update(path="absent/child"),
                   lambda rows: rows[1].update(xattrs={"security.capability": "AA=="}),
                   lambda rows: rows[1].update(kind="device"),
                   lambda rows: rows[1].update(extents=[{"offset": 3, "bytes": 4, "storedOffset": 0}]),
                   lambda rows: rows[1].update(bytes=True),
                   lambda rows: rows[0].update(kind="symlink", target="data")]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                self.rewrite_inventory(change)
                with self.assertRaises(c.CutRefused): list(c.read_raw_inventory(self.target_fd, lambda: None))
                (self.target / "inventory.jsonl").write_bytes(original_inventory)
                (self.target / "manifest.json").write_bytes(original_manifest)

    def test_symlink_metadata_is_observed_instead_of_silently_lost(self):
        (self.source / "data").write_bytes(b"kept")
        (self.source / "link").symlink_to("data")
        actual = os.listxattr
        def attributes(file, **kwargs):
            if kwargs.get("follow_symlinks") is False:
                return ["security.unknown"]
            return actual(file, **kwargs)
        with mock.patch.object(c.os, "listxattr", side_effect=attributes):
            with self.assertRaises(c.CutRefused): self.capture()
        self.assertFalse((self.target / "manifest.json").exists())

    def test_streaming_inert_restore_uses_no_source_and_preserves_metadata(self):
        self.assertTrue(callable(getattr(c, "materialize_raw_cut", None)), "an independent streaming oracle is required")
        (self.source / "empty").mkdir(mode=0o750)
        file = self.source / "private"
        with file.open("wb") as stream:
            stream.write(b"first"); stream.seek(8 * 1024 * 1024); stream.write(b"last")
        os.chmod(file, 0o640)
        os.utime(file, ns=(1234567890000000000, 1234567890123456789))
        os.setxattr(file, "user.kept", b"metadata")
        os.link(file, self.source / "other")
        (self.source / "link").symlink_to("private")
        self.capture()
        shutil.rmtree(self.source)
        destination = self.root / "restored"; destination.mkdir(mode=0o700)
        fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, fd)
        result = c.materialize_raw_cut(self.target_fd, fd, lambda: None, {os.getuid()}, {os.getgid()})
        self.assertEqual(result["kind"], "inert-raw-cut")
        restored = destination / "files" / "private"
        self.assertEqual(restored.stat().st_mtime_ns, 1234567890123456789)
        self.assertEqual(stat.S_IMODE(restored.stat().st_mode), 0o640)
        self.assertEqual(os.getxattr(restored, "user.kept"), b"metadata")
        self.assertEqual(restored.stat().st_ino, (restored.parent / "other").stat().st_ino)
        self.assertEqual(os.readlink(restored.parent / "link"), "private")
        self.assertEqual(restored.stat().st_size, 8 * 1024 * 1024 + 4)
        self.assertLess(restored.stat().st_blocks * 512, restored.stat().st_size)
        with restored.open("rb") as stream:
            self.assertEqual(stream.read(5), b"first"); stream.seek(-4, os.SEEK_END); self.assertEqual(stream.read(), b"last")

    def test_corrupt_last_payload_cannot_publish_restore_success_and_fds_close(self):
        self.assertTrue(callable(getattr(c, "materialize_raw_cut", None)), "an independent streaming oracle is required")
        (self.source / "data").write_bytes(b"kept")
        self.capture()
        next(self.target.glob("*.data")).write_bytes(b"bad!")
        destination = self.root / "restored"; destination.mkdir(mode=0o700)
        fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, fd)
        before = set(os.listdir("/proc/self/fd"))
        with self.assertRaises(c.CutRefused):
            c.materialize_raw_cut(self.target_fd, fd, lambda: None, {os.getuid()}, {os.getgid()})
        self.assertEqual(set(os.listdir("/proc/self/fd")), before)
        self.assertFalse((destination / "manifest.json").exists())

    def test_raw_walk_does_not_update_the_source_root_access_time(self):
        (self.source / "data").write_bytes(b"kept")
        atime = 1234567890000000000
        os.utime(self.source, ns=(atime, atime))
        self.capture()
        self.assertEqual(self.source.stat().st_atime_ns, atime)
