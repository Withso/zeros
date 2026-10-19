"""A remote rollback payload is metadata at boot, never a new receipt."""
import base64
import copy
import datetime
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest import mock

import test_bootstrap as fixtures
from test_bootstrap import NOW, b, canonical, digest, encoded, fixture


class RollbackCacheTests(unittest.TestCase):
    setUp = fixtures.BootstrapTests.setUp
    tearDown = fixtures.BootstrapTests.tearDown
    download = fixtures.BootstrapTests.download
    install = fixtures.BootstrapTests.install
    runtime = fixtures.BootstrapTests.runtime

    def pair(self):
        self.install()
        source = copy.deepcopy(self.value)
        source_payload = self.payload
        source_receipt = self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600)
        self.payload, self.value, self.manifest = fixture(extra={'worker/next.txt': b'next runtime\n'})
        self.install()
        return source, source_payload, source_receipt

    def reference(self, source, receipt, state='evicted'):
        value = {
            'schema': 'zeros.runtime-rollback-ref/v1',
            'retentionId': '77777777-7777-4777-8777-777777777777',
            'runtime': source['runtime'], 'baseCompatibilityId': self.app.compat_id,
            'installerReceipt': base64.urlsafe_b64encode(receipt).rstrip(b'=').decode(),
            'installerReceiptSha256': digest(receipt), 'state': state,
            'scope': {'workspaceId': '11111111-1111-4111-8111-111111111111',
                      'organizationId': '22222222-2222-4222-8222-222222222222',
                      'generation': 2, 'providerResourceId': 'bx_fixture', 'authorityEpoch': '8',
                      'intentId': '33333333-3333-4333-8333-333333333333'},
            'currentRuntimeId': self.value['runtime']['runtimeId'],
            'bootId': self.app.boot_id(), 'diskEpoch': self.app.epoch(),
        }
        self.app.atomic(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.rollback.json', canonical(value))
        return value

    def remove_payload(self, source):
        shutil.rmtree(self.runtime(source))

    def test_boot_preserves_previous_proof_without_opening_its_evicted_tree(self):
        source, _, receipt = self.pair()
        self.reference(source, receipt)
        self.remove_payload(source)
        previous = source['runtime']['runtimeId']
        read = self.app.read

        def checked_read(path, *args, **kwargs):
            self.assertFalse(path.startswith(b.INFRA + '/' + previous + '/'), 'boot opened the rollback payload')
            return read(path, *args, **kwargs)

        with mock.patch.object(self.app, 'read', side_effect=checked_read), \
                mock.patch.object(self.app, 'downloader', side_effect=AssertionError('boot fetched rollback')):
            self.app.boot()
        self.assertEqual(self.app.current('previous'), previous)
        self.assertEqual(read(b.RECEIPTS + '/' + previous + '.json', 4096, 0o600), receipt)
        self.assertEqual(self.app.current(), self.value['runtime']['runtimeId'])

    def test_interrupted_eviction_is_not_cleaned_or_walked_during_ordinary_boot(self):
        source, _, receipt = self.pair()
        self.reference(source, receipt, 'evicting')
        previous = source['runtime']['runtimeId']
        (self.runtime(source) / 'worker/data.txt').unlink()
        read = self.app.read

        def checked_read(path, *args, **kwargs):
            self.assertFalse(path.startswith(b.INFRA + '/' + previous + '/'))
            return read(path, *args, **kwargs)

        with mock.patch.object(self.app, 'read', side_effect=checked_read), \
                mock.patch.object(self.app, 'remove_entries', wraps=self.app.remove_entries) as removed:
            self.app.boot()
        self.assertEqual(read(b.RECEIPTS + '/' + previous + '.json', 4096, 0o600), receipt)
        self.assertFalse(any(call.args[0] == b.INFRA and previous in call.args[1] for call in removed.call_args_list))

    def test_ref_does_not_hide_an_absent_current_runtime(self):
        source, _, receipt = self.pair()
        self.reference(source, receipt)
        self.remove_payload(source)
        self.app.link(b.FACADE + '/current', '../zeros-infra/' + source['runtime']['runtimeId'], replace=True)
        with self.assertRaises(b.Failure):
            self.app.boot()
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_corrupt_retained_receipt_is_not_erased_as_an_incomplete_install(self):
        source, _, receipt = self.pair()
        ref = self.reference(source, receipt)
        ref['installerReceiptSha256'] = '0' * 64
        self.app.atomic(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.rollback.json', canonical(ref))
        self.remove_payload(source)
        with self.assertRaises(b.Failure):
            self.app.boot()
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_cached_install_records_the_exact_descriptor_separately_from_receipt(self):
        self.install()
        descriptor = self.app.read(b.RECEIPTS + '/' + self.value['runtime']['runtimeId'] + '.descriptor.json', 4096, 0o600)
        self.assertEqual(json.loads(descriptor), self.value['runtime'])
        self.assertNotIn('private-canary', descriptor.decode())

    def test_explicit_restore_preserves_original_receipt_bytes_and_does_not_activate(self):
        source, payload, receipt = self.pair()
        ref = self.reference(source, receipt)
        self.remove_payload(source)
        active_before = self.app.read(b.ACTIVE, 4096, 0o600)
        current = self.app.current()
        epoch = self.app.epoch()
        self.payload = payload
        self.app.now = lambda: NOW + datetime.timedelta(seconds=1)
        deadline = NOW + datetime.timedelta(seconds=241)
        checks = []
        self.app.restore_rollback(source, ref, deadline=deadline, authorize=lambda: checks.append('authorize') or True)
        self.assertGreaterEqual(len(checks), 2, 'authority must be checked before and after download')
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)
        self.assertEqual(self.app.current(), current)
        self.assertEqual(self.app.epoch(), epoch)
        self.assertEqual(self.app.read(b.ACTIVE, 4096, 0o600), active_before)
        self.app.verify_runtime(source['runtime']['runtimeId'], full=True, descriptor=source['runtime'])

    def test_ordinary_install_cannot_turn_an_evicted_reference_into_a_new_receipt(self):
        source, payload, receipt = self.pair()
        self.reference(source, receipt)
        self.remove_payload(source)
        self.payload = payload
        self.app.now = lambda: NOW + datetime.timedelta(seconds=1)
        with self.assertRaises(b.Failure):
            self.app.install(encoded(source))
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)


if __name__ == '__main__':
    unittest.main()
