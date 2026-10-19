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
            self.app.install(encoded(self.value))
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

    def evicted(self):
        source, payload, receipt = self.pair()
        ref = self.reference(source, receipt)
        self.remove_payload(source)
        self.payload = payload
        return source, ref, receipt

    def restore(self, source, ref, **options):
        self.app.restore_rollback(source, ref, deadline=NOW + datetime.timedelta(seconds=240),
                                  authorize=options.pop('authorize', lambda: True), **options)

    def test_completed_restore_replay_keeps_its_original_deadline_and_receipt(self):
        source, ref, receipt = self.evicted()
        self.restore(source, ref)
        restored = self.app.rollback_reference(source['runtime']['runtimeId'])
        with mock.patch.object(self.app, 'downloader', side_effect=AssertionError('replay downloaded')):
            self.restore(source, restored)
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_restore_replay_cannot_reset_its_durable_deadline(self):
        source, ref, _ = self.evicted()
        self.app.downloader = lambda *_: self.fail('download unavailable')
        with self.assertRaises(AssertionError):
            self.restore(source, ref)
        self.app.now = lambda: NOW + datetime.timedelta(seconds=1)
        with self.assertRaises(b.Failure):
            self.app.restore_rollback(source, ref, deadline=NOW + datetime.timedelta(seconds=241), authorize=lambda: True)

    def test_corrupt_archive_cannot_replace_retained_receipt_or_activate(self):
        source, ref, receipt = self.evicted()
        active = self.app.read(b.ACTIVE, 4096, 0o600)
        self.payload = b'x' * len(self.payload)
        with self.assertRaises(b.Failure):
            self.restore(source, ref)
        self.assertFalse(self.runtime(source).exists())
        self.assertEqual(self.app.read(b.ACTIVE, 4096, 0o600), active)
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_expired_fetch_refuses_publication_and_keeps_current(self):
        source, ref, receipt = self.evicted()
        download = self.app.downloader
        current = self.app.current()

        def delayed(*args):
            download(*args)
            self.app.now = lambda: NOW + datetime.timedelta(seconds=240)

        self.app.downloader = delayed
        with self.assertRaises(b.Failure):
            self.restore(source, ref)
        self.assertFalse(self.runtime(source).exists())
        self.assertEqual(self.app.current(), current)
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_stale_epoch_after_download_cannot_publish(self):
        source, ref, _ = self.evicted()
        download = self.app.downloader

        def changed(*args):
            download(*args)
            self.app.atomic(b.FACADE + '/disk-epoch', b'99\n')

        self.app.downloader = changed
        with self.assertRaises(b.Failure):
            self.restore(source, ref)
        self.assertFalse(self.runtime(source).exists())

    def test_cancelled_authority_during_extraction_cannot_publish(self):
        source, ref, receipt = self.evicted()
        allowed = True
        extract = self.app.extract

        def changed(*args):
            nonlocal allowed
            extract(*args)
            allowed = False

        self.app.extract = changed
        with self.assertRaises(b.Failure):
            self.restore(source, ref, authorize=lambda: allowed)
        self.assertFalse(self.runtime(source).exists())
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_crash_after_payload_verification_never_promotes_it_at_boot(self):
        source, ref, receipt = self.evicted()
        current = self.app.current()

        def crash(stage):
            if stage == 'incomplete_removed': raise fixtures.Crash()

        self.app.fault = crash
        with self.assertRaises(fixtures.Crash):
            self.restore(source, ref)
        self.app.fault = lambda _: None
        self.app.boot()
        self.assertEqual(self.app.current(), current)
        self.assertEqual(self.app.rollback_reference(source['runtime']['runtimeId'])['state'], 'evicted')
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_evicted_metadata_does_not_skip_current_payload_integrity(self):
        source, _, _ = self.evicted()
        (self.runtime() / 'worker/data.txt').write_bytes(b'changed')
        self.app.boot()
        with self.assertRaises(b.Failure):
            self.app.install(encoded(self.value))
        self.assertFalse(self.runtime(source).exists())

    def test_old_base_cannot_enable_eviction_or_restore(self):
        source, ref, _ = self.evicted()
        self.app.compat.pop('runtimeRollbackCacheVersion')
        with self.assertRaises(b.Failure):
            self.restore(source, ref)

    def eviction_request(self, source, receipt):
        reference = self.reference(source, receipt)
        self.app.unlink(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.rollback.json')
        return {'scope': reference['scope'], 'current': json.loads(self.app.read(b.ACTIVE, 4096, 0o600)),
                'expiresAt': '2026-10-04T00:01:00Z'}

    def test_sealed_stop_evicts_only_after_durable_retention_and_positive_host_retirement(self):
        source, _, receipt = self.pair()
        request = self.eviction_request(source, receipt)
        events = []
        stop = self.host.stop
        self.host.stop = lambda: (events.append('retire'), stop())[-1]

        def retain(offer):
            self.assertTrue(self.runtime(source).is_dir())
            self.assertEqual(offer['runtime'], source['runtime'])
            self.assertEqual(offer['installerReceiptSha256'], digest(receipt))
            events.append('retain')
            return '77777777-7777-4777-8777-777777777777'

        self.app.evict_previous(request, retain=retain, authorize=lambda phase: events.append(phase) or True)
        self.assertEqual(events, ['retain', 'retire_authorized', 'retire', 'evict_authorized'])
        self.assertFalse(self.runtime(source).exists())
        self.assertTrue(self.runtime().is_dir())
        self.assertEqual(self.app.current('previous'), source['runtime']['runtimeId'])
        self.assertEqual(self.app.rollback_reference(source['runtime']['runtimeId'])['state'], 'evicted')
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_lost_retention_ack_never_retires_or_evicts(self):
        source, _, receipt = self.pair()
        request = self.eviction_request(source, receipt)
        self.host.calls.clear()
        with self.assertRaises(b.Failure):
            self.app.evict_previous(request, retain=lambda _: None, authorize=lambda _: True)
        self.assertNotIn('stop', self.host.calls)
        self.assertTrue(self.runtime(source).is_dir())

    def test_unsettled_transfer_blocks_eviction_even_with_retention_ack(self):
        source, _, receipt = self.pair()
        request = self.eviction_request(source, receipt)
        self.app.atomic(b.RECEIPTS + '/update.json', canonical({'schema': 'zeros.runtime-update/v1', 'phase': 'source_retired'}))
        with self.assertRaises(b.Failure):
            self.app.evict_previous(request, retain=lambda _: self.fail('unsettled transfer offered for eviction'), authorize=lambda _: True)
        self.assertTrue(self.runtime(source).is_dir())

    def test_stale_disk_epoch_after_retention_ack_cannot_retire_or_evict(self):
        source, _, receipt = self.pair()
        request = self.eviction_request(source, receipt)
        self.host.calls.clear()

        def retain(_):
            self.app.atomic(b.FACADE + '/disk-epoch', b'99\n')
            return '77777777-7777-4777-8777-777777777777'

        with self.assertRaises(b.Failure):
            self.app.evict_previous(request, retain=retain, authorize=lambda _: True)
        self.assertTrue(self.runtime(source).is_dir())
        self.assertNotIn('stop', self.host.calls)

    def test_late_cancellation_after_retirement_keeps_previous_payload(self):
        source, _, receipt = self.pair()
        request = self.eviction_request(source, receipt)
        with self.assertRaises(b.Failure):
            self.app.evict_previous(request, retain=lambda _: '77777777-7777-4777-8777-777777777777',
                                    authorize=lambda phase: phase == 'retire_authorized')
        self.assertTrue(self.runtime(source).is_dir())

    def test_unproven_whole_host_retirement_never_evicts_a_resident_runtime(self):
        source, _, receipt = self.pair()
        request = self.eviction_request(source, receipt)
        self.host.stop = lambda: None
        with self.assertRaises(b.Failure):
            self.app.evict_previous(request, retain=lambda _: '77777777-7777-4777-8777-777777777777', authorize=lambda _: True)
        self.assertTrue(self.runtime(source).is_dir())

    def test_nested_mount_blocks_payload_removal(self):
        source, _, receipt = self.pair()
        request = self.eviction_request(source, receipt)
        self.mounts.links[str(self.runtime(source) / 'worker')] = '/foreign'
        with self.assertRaises(b.Failure):
            self.app.evict_previous(request, retain=lambda _: '77777777-7777-4777-8777-777777777777', authorize=lambda _: True)
        self.assertTrue((self.runtime(source) / 'worker/data.txt').exists())

    def test_interruption_after_eviction_intent_preserves_the_original_proof(self):
        source, _, receipt = self.pair()
        request = self.eviction_request(source, receipt)

        def crash(stage):
            if stage == 'rollback_eviction_intent': raise fixtures.Crash()

        self.app.fault = crash
        with self.assertRaises(fixtures.Crash):
            self.app.evict_previous(request, retain=lambda _: '77777777-7777-4777-8777-777777777777', authorize=lambda _: True)
        self.app.fault = lambda _: None
        self.app.boot()
        self.assertEqual(self.app.rollback_reference(source['runtime']['runtimeId'])['state'], 'evicting')
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)



if __name__ == '__main__':
    unittest.main()
