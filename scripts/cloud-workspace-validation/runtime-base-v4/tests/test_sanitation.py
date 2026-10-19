"""Real base-template sanitation against an owned synthetic filesystem."""
import contextlib
import errno
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import sys
import types
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

    def sanitize(self, template=None):
        template = template or fixtures.template("sanitize.py")
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

    def prepare_base(self):
        self.write('/etc/zeros/cloud-worker.json', json.dumps({'version': 4}).encode(), 0o444)
        self.write('/opt/zeros-bootstrap/computer-build.py', (HERE.parent / 'computer-build.py').read_bytes(), 0o555)
        # Stub only native systemd transit, retaining real locks, boot ID,
        # epoch, facade and persistence checks in Bootstrap.wait_ready.
        self.app.host.wait_ready = mock.Mock()

    def builder_ready(self, *, cold=False):
        verifier = fixtures.template('verify.py')

        class Ready(Exception): pass

        # Stop before the OS package probes; the actual builder caller has
        # already checked readiness on the owned filesystem.
        with mock.patch.object(verifier, 'COLD_BOOT', cold), \
             mock.patch.object(verifier, 'verify_protected_ancestry', side_effect=Ready):
            with self.assertRaises(Ready): verifier.verify_host(fixtures.b, self.app)

    def sanitize_entry(self):
        template = fixtures.template('sanitize.py')
        spec_from_path, from_spec = template.importlib.util.spec_from_file_location, template.importlib.util.module_from_spec
        injected = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _module: None))

        def lookup(name, path):
            return injected if str(path) == '/opt/zeros-bootstrap/bootstrap.py' else spec_from_path(name, path)

        def module(spec):
            return types.SimpleNamespace(Bootstrap=lambda: self.app) if spec is injected else from_spec(spec)

        with mock.patch.object(template.importlib.util, 'spec_from_file_location', side_effect=lookup), \
             mock.patch.object(template.importlib.util, 'module_from_spec', side_effect=module), \
             mock.patch.object(template.os, 'geteuid', return_value=0), \
             mock.patch.object(template.sys, 'argv', ['sanitize.py']):
            return template.sanitize()

    def test_builder_verification_survives_both_same_boot_sanitations(self):
        self.prepare_base()
        self.app.wait_ready()
        self.assertGreater(self.app.epoch(), 0)
        for _ in range(2):
            self.assertTrue(self.sanitize_entry()['clean'])
            self.builder_ready()
            self.assertEqual(self.app.epoch(), 0, 'verification must not refill capture markers')
        self.app.host.wait_ready.assert_called()

    def test_ordinary_and_cold_readiness_remain_strict_after_sanitation(self):
        self.prepare_base()
        self.sanitize()
        with self.assertRaises(fixtures.b.Failure) as refused: self.app.wait_ready()
        self.assertEqual(refused.exception.checks, ['pointer_publish'])
        with self.assertRaises(fixtures.b.Failure) as refused: self.builder_ready(cold=True)
        self.assertEqual(refused.exception.checks, ['pointer_publish'])
        # The real new-boot path creates a positive epoch and is idempotent.
        self.app.boot_id = lambda: '87654321-4321-4321-8321-876543210abc'
        self.app.boot()
        self.app.wait_ready()
        self.builder_ready(cold=True)
        self.assertEqual(self.app.epoch(), 1)
        self.app.boot()
        self.assertEqual(self.app.epoch(), 1)

    def test_empty_builder_readiness_refuses_partial_or_malformed_markers(self):
        self.prepare_base()
        self.sanitize()
        for path in ('/opt/zeros/disk-epoch', '/opt/zeros/sessions/boot.json',
                     '/opt/zeros/sessions/reconciliation.json', fixtures.b.ACTIVE):
            for value in (None, b'0\n', b'null', b'{}', b' '):
                with self.subTest(path=path, value=value):
                    if value is None: self.app.path(path).unlink()
                    else: self.app.atomic(path, value)
                    with self.assertRaises((fixtures.b.Failure, OSError)): self.builder_ready()
                    self.app.atomic(path, b'')

    def test_empty_builder_readiness_refuses_nonempty_runtime_custody(self):
        self.prepare_base()
        self.sanitize()
        for path in ('/opt/zeros-infra/runtime', '/opt/zeros-infra/.staging/pending',
                     '/srv/zeros/runtime-installs/receipt'):
            entry = self.write(path, b'pending runtime')
            try:
                with self.assertRaises(fixtures.b.Failure): self.builder_ready()
                self.assertEqual(entry.read_bytes(), b'pending runtime')
            finally: entry.unlink()
        for name in ('current', 'previous'):
            self.app.link('/opt/zeros/' + name, '../zeros-infra/' + self.value['runtime']['runtimeId'])
            try:
                with self.assertRaises(fixtures.b.Failure): self.builder_ready()
            finally: self.app.path('/opt/zeros/' + name).unlink()

    def test_empty_builder_readiness_checks_original_marker_metadata(self):
        self.prepare_base()
        self.sanitize()
        other = self.write('/outside/empty', b'')
        for path in ('/opt/zeros/disk-epoch', '/opt/zeros/sessions/boot.json',
                     '/opt/zeros/sessions/reconciliation.json', fixtures.b.ACTIVE, fixtures.b.BASE_SANITATION):
            target = self.app.path(path)
            for kind in ('mode', 'symlink', 'hardlink', 'directory'):
                with self.subTest(path=path, kind=kind):
                    target.unlink()
                    if kind == 'mode': self.write(path, b'', 0o644)
                    elif kind == 'symlink': target.symlink_to(other)
                    elif kind == 'hardlink': os.link(other, target)
                    else: target.mkdir()
                    try:
                        with self.assertRaises((fixtures.b.Failure, OSError)): self.builder_ready()
                    finally:
                        if kind == 'directory': target.rmdir()
                        else: target.unlink()
                        self.app.atomic(path, b'')
        self.assertEqual(other.read_bytes(), b'')

    def test_empty_builder_readiness_keeps_install_then_publication_lock_order(self):
        self.prepare_base()
        self.sanitize()
        held, calls = [], []
        lock = self.app.lock

        @contextlib.contextmanager
        def observed(name):
            with lock(name):
                held.append(name)
                calls.append(tuple(held))
                try: yield
                finally: held.pop()

        with mock.patch.object(self.app, 'lock', side_effect=observed):
            self.builder_ready()
        self.assertEqual(calls, [('runtime-install.lock',), ('runtime-install.lock', 'runtime-publication.lock')])

    def test_base_verification_refuses_unfinished_sanitation_even_after_fresh_boot(self):
        self.prepare_base()
        self.sanitize()
        self.app.boot_id = lambda: '87654321-4321-4321-8321-876543210abc'
        self.app.boot()
        self.app.wait_ready()
        self.app.atomic(fixtures.b.BASE_SANITATION, b'pending\n')
        verifier = fixtures.template('verify.py')
        with self.assertRaises(fixtures.b.Failure): verifier.verify_empty_base_state(fixtures.b, self.app)

    def interrupt_exchange(self, *, top_level_cache=False):
        link, document = self.prepare_stock_log()
        self.prepare_base()
        if top_level_cache:
            link.unlink()
            link = self.app.path('/home/user/.cache')
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(document.parent, target_is_directory=True)
        template = fixtures.template('sanitize.py')
        exchange = template.exchange_stock_leaf

        def replace_before_exchange(source, source_name, destination, destination_name):
            link.unlink()
            link.write_bytes(b'unknown displaced synthetic bytes')
            exchange(source, source_name, destination, destination_name)

        with mock.patch.object(template, 'exchange_stock_leaf', side_effect=replace_before_exchange):
            with self.assertRaises(RuntimeError): self.sanitize(template)
        custody = list(link.parent.glob('.zeros-base-sanitize-*'))
        self.assertEqual(len(custody), 1)
        displaced = custody[0] / 'entry'
        self.assertEqual(displaced.read_bytes(), b'unknown displaced synthetic bytes')
        self.assertEqual(self.app.read(fixtures.b.BASE_SANITATION, 64, 0o600), b'pending\n')
        return displaced

    def fresh_boot(self):
        # Drop only the test-owned volatile tree, then run real boot repair.
        shutil.rmtree(self.app.path('/run/zeros'))
        self.app.boot_id = lambda: '87654321-4321-4321-8321-876543210abc'
        self.app.boot()
        self.app.wait_ready()

    def assert_pending_custody(self, displaced):
        # Both the direct producer and cold empty-state consumer must refuse.
        with self.assertRaises(fixtures.b.Failure): self.sanitize()
        verifier = fixtures.template('verify.py')
        with self.assertRaises(fixtures.b.Failure): verifier.verify_empty_base_state(fixtures.b, self.app)
        self.assertEqual(displaced.read_bytes(), b'unknown displaced synthetic bytes')
        self.assertEqual(self.app.read(fixtures.b.BASE_SANITATION, 64, 0o600), b'pending\n')

    def test_control_same_boot_retry_keeps_unknown_custody(self):
        displaced = self.interrupt_exchange()
        with self.assertRaises(fixtures.b.Failure): self.sanitize_entry()
        self.assert_pending_custody(displaced)

    def test_control_successful_sanitation_survives_a_real_volatile_reset(self):
        link, document = self.prepare_stock_log()
        self.prepare_base()
        self.sanitize_entry()
        self.fresh_boot()
        self.builder_ready(cold=True)
        self.assertTrue(self.sanitize_entry()['clean'])
        self.assertEqual(self.app.read(fixtures.b.BASE_SANITATION, 0, 0o600), b'')
        self.assertEqual(link.read_bytes(), b'')
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_failed_custody_must_block_after_a_real_volatile_reset(self):
        displaced = self.interrupt_exchange()
        self.fresh_boot()
        refused = False
        try: self.sanitize_entry()
        except (RuntimeError, fixtures.b.Failure): refused = True
        self.assertTrue(refused, 'lost volatile marker allowed clean success after failed exchange; displaced length=' + str(displaced.stat().st_size))
        self.assert_pending_custody(displaced)

    def test_root_leaf_custody_must_not_escape_the_private_walk_after_reboot(self):
        displaced = self.interrupt_exchange(top_level_cache=True)
        self.fresh_boot()
        refused = False
        try: self.sanitize_entry()
        except (RuntimeError, fixtures.b.Failure): refused = True
        self.assertTrue(refused, 'lost volatile marker allowed clean success while out-of-walk custody retained nonempty bytes; displaced length=' + str(displaced.stat().st_size))
        self.assert_pending_custody(displaced)

    def test_empty_builder_readiness_does_not_skip_native_cgroup_initialization(self):
        self.prepare_base()
        self.sanitize()
        self.app.host = fixtures.b.SystemHost()
        scope = fixtures.cgroup_fixture(self.root)
        (scope / 'host/memory.max').write_text('max\n')
        with mock.patch.object(fixtures.b, 'CGROUP', str(scope)), \
             mock.patch.object(fixtures.b.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout=fixtures.units())), \
             mock.patch.object(fixtures.b.time, 'sleep'), \
             mock.patch.object(fixtures.b.time, 'monotonic', side_effect=[0, 0, 600]):
            with self.assertRaises(fixtures.b.Failure) as refused: self.builder_ready()
        self.assertEqual(refused.exception.checks, ['timeout'])

    def test_empty_builder_readiness_keeps_boot_host_facade_and_persistence_guards(self):
        self.prepare_base()
        self.sanitize()
        with mock.patch.object(self.app, 'boot_id', return_value='87654321-4321-4321-8321-876543210abc'):
            with self.assertRaises(fixtures.b.Failure): self.builder_ready()
        with mock.patch.object(self.app.host, 'wait_ready', side_effect=fixtures.b.Failure('host_start')):
            with self.assertRaises(fixtures.b.Failure): self.builder_ready()
        self.app.path('/zeros').unlink()
        self.app.path('/zeros').symlink_to('/foreign')
        with self.assertRaises(fixtures.b.Failure): self.builder_ready()
        self.app.path('/zeros').unlink()
        self.app.path('/zeros').symlink_to('/opt/zeros')
        self.app.atomic(fixtures.b.PERSIST_RECORD, b'{}')
        with self.assertRaises(fixtures.b.Failure): self.builder_ready()

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

    def prepare_stock_log(self, target='../../usr/share/doc/systemd/README.logs'):
        self.write('/etc/zeros/cloud-worker.json', json.dumps({'version': 4}).encode(), 0o444)
        self.write('/opt/zeros-bootstrap/computer-build.py', (HERE.parent / 'computer-build.py').read_bytes(), 0o555)
        document = self.write('/usr/share/doc/systemd/README.logs', b'public stock documentation', 0o644)
        link = self.app.path('/var/log/README')
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target)
        return link, document

    def test_base_sanitation_replaces_stock_log_document_link_without_following_it(self):
        link, document = self.prepare_stock_log()
        original = document.stat().st_ino
        self.assertTrue(self.sanitize()['clean'])
        self.assertFalse(link.is_symlink())
        self.assertEqual(link.read_bytes(), b'')
        self.assertEqual(link.stat().st_nlink, 1)
        self.assertEqual(document.read_bytes(), b'public stock documentation')
        self.assertEqual(document.stat().st_ino, original)
        # A subsequent sanitize preserves the empty regular replacement.
        replacement = link.stat().st_ino
        self.assertTrue(self.sanitize()['clean'])
        self.assertEqual(link.stat().st_ino, replacement)

    def test_base_sanitation_replaces_stock_directory_links_without_traversal(self):
        link, document = self.prepare_stock_log()
        link.unlink()
        link = self.app.path('/root/.codex/skills/shared')
        link.parent.mkdir(parents=True)
        link.symlink_to(document.parent, target_is_directory=True)
        self.assertTrue(self.sanitize()['clean'])
        self.assertTrue(stat.S_ISREG(link.lstat().st_mode))
        self.assertEqual(link.read_bytes(), b'')
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_base_sanitation_replaces_stock_cache_socket_without_connecting(self):
        link, _ = self.prepare_stock_log()
        link.unlink()
        target = self.app.path('/home/user/.cache/stock/socket')
        target.parent.mkdir(parents=True)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.bind(str(target))
            self.assertTrue(self.sanitize()['clean'])
            self.assertEqual(target.read_bytes(), b'')
            self.assertTrue(stat.S_ISREG(target.lstat().st_mode))

    def test_base_sanitation_never_reads_or_changes_an_alias_target(self):
        link, document = self.prepare_stock_log('/outside/private')
        victim = self.write('/outside/private', b'unrelated private bytes')
        self.assertTrue(self.sanitize()['clean'])
        self.assertEqual(link.read_bytes(), b'')
        self.assertEqual(victim.read_bytes(), b'unrelated private bytes')
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_base_normalization_never_adopts_a_substituted_custody_directory(self):
        link, document = self.prepare_stock_log()
        template = fixtures.template('sanitize.py')
        mkdir = os.mkdir
        substituted = []

        def substitute(name, mode=0o777, *, dir_fd=None):
            mkdir(name, mode, dir_fd=dir_fd)
            if str(name).startswith('.zeros-base-sanitize-'):
                os.rmdir(name, dir_fd=dir_fd)
                mkdir(name, 0o777, dir_fd=dir_fd)
                path = link.parent / name
                path.chmod(0o777)
                (path / 'foreign').write_bytes(b'unrelated bytes')
                substituted.append(path)

        with mock.patch.object(template.os, 'mkdir', side_effect=substitute):
            with self.assertRaises(RuntimeError): self.sanitize(template)
        self.assertEqual(len(substituted), 1)
        self.assertEqual(stat.S_IMODE(substituted[0].stat().st_mode), 0o777)
        self.assertEqual((substituted[0] / 'foreign').read_bytes(), b'unrelated bytes')
        self.assertTrue(link.is_symlink())
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_base_normalization_supports_provider_parent_modes_with_private_bounded_custody(self):
        link, document = self.prepare_stock_log()
        for mode in (0o775, 0o2755):
            with self.subTest(mode=mode):
                link.parent.chmod(mode)
                self.sanitize()
                custody = list(link.parent.glob('.zeros-base-sanitize-*'))
                self.assertEqual(len(custody), 1)
                self.assertEqual(stat.S_IMODE(custody[0].stat().st_mode), 0o700)
                self.assertEqual((custody[0].stat().st_uid, custody[0].stat().st_gid), (self.app.uid, self.app.gid))
                self.assertEqual([path.name for path in custody[0].iterdir()], ['entry'])
                for path in (link, custody[0] / 'entry'):
                    self.assertEqual((stat.S_IMODE(path.stat().st_mode), path.stat().st_size, path.stat().st_nlink), (0o600, 0, 1))
                self.assertEqual(document.read_bytes(), b'public stock documentation')
                # Repetition never adds custody to already regular leaves.
                self.sanitize()
                self.assertEqual(list(link.parent.glob('.zeros-base-sanitize-*')), custody)
                link.unlink()
                (custody[0] / 'entry').unlink()
                custody[0].rmdir()
                link.symlink_to(document)

    def test_base_normalization_refuses_a_leaf_replaced_before_its_open(self):
        link, document = self.prepare_stock_log()
        template = fixtures.template('sanitize.py')
        victim = self.write('/outside/private', b'unrelated bytes')
        original_open, raced = os.open, False

        def replace_before_open(name, flags, *args, **kwargs):
            nonlocal raced
            if name == 'README' and flags & os.O_PATH and not raced:
                raced = True
                link.unlink()
                os.link(victim, link)
            return original_open(name, flags, *args, **kwargs)

        with mock.patch.object(template.os, 'open', side_effect=replace_before_open):
            with self.assertRaises(RuntimeError): self.sanitize(template)
        self.assertTrue(raced)
        self.assertEqual(victim.read_bytes(), b'unrelated bytes')
        self.assertEqual(list(link.parent.glob('.zeros-base-sanitize-*')), [])
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_base_normalization_retains_unknown_displaced_leaf_after_exchange(self):
        link, document = self.prepare_stock_log()
        template = fixtures.template('sanitize.py')
        exchange = template.exchange_stock_leaf

        def substitute(source, source_name, destination, destination_name):
            link.unlink()
            link.write_bytes(b'unknown displaced bytes')
            exchange(source, source_name, destination, destination_name)

        with mock.patch.object(template, 'exchange_stock_leaf', side_effect=substitute):
            with self.assertRaises(RuntimeError): self.sanitize(template)
        custody = list(link.parent.glob('.zeros-base-sanitize-*'))
        self.assertEqual(len(custody), 1)
        self.assertEqual((custody[0] / 'entry').read_bytes(), b'unknown displaced bytes')
        self.assertEqual(link.read_bytes(), b'')
        self.assertEqual(document.read_bytes(), b'public stock documentation')
        # A new invocation has no authority to reinterpret unknown custody as
        # ordinary private state and truncate it on the way to a clean result.
        with self.assertRaises((RuntimeError, fixtures.b.Failure)): self.sanitize()
        self.assertEqual((custody[0] / 'entry').read_bytes(), b'unknown displaced bytes')

    def test_base_normalization_retains_displaced_alias_if_ancestor_moves(self):
        link, document = self.prepare_stock_log()
        template = fixtures.template('sanitize.py')
        exchange = template.exchange_stock_leaf
        moved = link.parent.with_name('moved')

        def move_parent(source, source_name, destination, destination_name):
            exchange(source, source_name, destination, destination_name)
            link.parent.rename(moved)
            link.parent.mkdir()
            (link.parent / 'foreign').write_bytes(b'new parent bytes')

        with mock.patch.object(template, 'exchange_stock_leaf', side_effect=move_parent):
            with self.assertRaises(RuntimeError): self.sanitize(template)
        custody = list(moved.glob('.zeros-base-sanitize-*'))
        self.assertEqual(len(custody), 1)
        self.assertTrue((custody[0] / 'entry').is_symlink())
        self.assertEqual((link.parent / 'foreign').read_bytes(), b'new parent bytes')
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_base_normalization_retains_displaced_alias_if_a_link_appears_after_exchange(self):
        link, document = self.prepare_stock_log()
        template = fixtures.template('sanitize.py')
        exchange = template.exchange_stock_leaf

        def add_alias(source, source_name, destination, destination_name):
            exchange(source, source_name, destination, destination_name)
            os.link('entry', 'alias', src_dir_fd=source, dst_dir_fd=source, follow_symlinks=False)

        with mock.patch.object(template, 'exchange_stock_leaf', side_effect=add_alias):
            with self.assertRaises(RuntimeError): self.sanitize(template)
        custody = list(link.parent.glob('.zeros-base-sanitize-*'))
        self.assertEqual(len(custody), 1)
        self.assertTrue((custody[0] / 'entry').is_symlink())
        self.assertEqual((custody[0] / 'entry').lstat().st_nlink, 2)
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_base_normalization_never_falls_back_when_atomic_exchange_is_unavailable(self):
        link, document = self.prepare_stock_log()
        template = fixtures.template('sanitize.py')
        with mock.patch.object(template, 'exchange_stock_leaf', side_effect=OSError(errno.ENOSYS, 'unavailable')):
            with self.assertRaises(OSError): self.sanitize(template)
        self.assertTrue(link.is_symlink())
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_base_normalization_never_claims_durability_after_sync_failure(self):
        link, document = self.prepare_stock_log()
        template = fixtures.template('sanitize.py')
        fsync = os.fsync
        parent_inode = link.parent.stat().st_ino

        def fail_parent(fd):
            if os.fstat(fd).st_ino == parent_inode: raise OSError(errno.EIO, 'sync')
            fsync(fd)

        with mock.patch.object(template.os, 'fsync', side_effect=fail_parent):
            with self.assertRaises(OSError): self.sanitize(template)
        self.assertEqual(document.read_bytes(), b'public stock documentation')
        self.assertEqual(link.read_bytes(), b'')

    def test_base_normalization_refuses_more_than_256_stock_leaves(self):
        link, document = self.prepare_stock_log()
        link.unlink()
        for index in range(257): (link.parent / f'link-{index:03d}').symlink_to(document)
        with self.assertRaises(RuntimeError): self.sanitize()
        self.assertEqual(len(list(link.parent.glob('.zeros-base-sanitize-*'))), 256)
        self.assertTrue((link.parent / 'link-256').is_symlink())
        self.assertEqual(document.read_bytes(), b'public stock documentation')

    def test_base_normalization_refuses_installed_or_retained_runtime_before_any_change(self):
        link, _ = self.prepare_stock_log()
        for root in ('/opt/zeros-infra/runtime', '/opt/zeros-infra/.staging/pending', '/srv/zeros/runtime-installs/receipt'):
            entry = self.write(root, b'installed or pending runtime')
            try:
                with self.assertRaises(fixtures.b.Failure): self.sanitize()
                self.assertTrue(link.is_symlink())
                self.assertEqual(entry.read_bytes(), b'installed or pending runtime')
            finally:
                entry.unlink()

    def refuse_special(self, kind):
        link, _ = self.prepare_stock_log()
        link.unlink()
        victim = self.write('/outside/private', b'unrelated private bytes')
        if kind == 'hardlink': os.link(victim, link)
        else: os.mkfifo(link)
        with self.assertRaisesRegex(Exception, 'sanitation_failed'): self.sanitize()
        self.assertEqual(victim.read_bytes(), b'unrelated private bytes')

    def test_base_normalization_keeps_hardlink_refusal(self):
        self.refuse_special('hardlink')

    def test_base_normalization_keeps_fifo_refusal(self):
        self.refuse_special('fifo')


if __name__ == "__main__":
    unittest.main()
