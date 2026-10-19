"""Exact previous payload restoration uses the deployed private adapter."""
import base64
import copy
import datetime
import json
import shutil
import unittest
from unittest import mock
import test_update as fixtures

b, update = fixtures.b, fixtures.update


class RollbackAdapterTests(unittest.TestCase):
    setUp = fixtures.UpdateTests.setUp
    tearDown = fixtures.UpdateTests.tearDown
    snapshot = fixtures.UpdateTests.snapshot
    stage = fixtures.UpdateTests.stage
    activate = fixtures.UpdateTests.activate

    def pair(self):
        source = copy.deepcopy(self.case.value)
        receipt = self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600)
        self.app.install(fixtures.fixture.encoded(self.install))
        self.source = json.loads(self.app.read(b.ACTIVE, 4096, 0o600))
        scope = {'workspaceId': self.request['scope']['workspaceId'], 'organizationId': self.request['scope']['organizationId'],
                 'generation': 1, 'providerResourceId': 'bx_fixture', 'authorityEpoch': '8',
                 'intentId': '33333333-3333-4333-8333-333333333333'}
        self.eviction = {'schema': 'zeros.runtime-rollback-cache/v1', 'operation': 'evict', 'scope': scope,
                         'current': self.source, 'expiresAt': '2026-10-04T00:01:00Z', 'fence': self.request['fence']}
        return source, receipt

    def evicted(self):
        source, receipt = self.pair()
        self.ref = {'schema': 'zeros.runtime-rollback-ref/v1', 'retentionId': '77777777-7777-4777-8777-777777777777',
                    'runtime': source['runtime'], 'baseCompatibilityId': self.app.compat_id,
                    'installerReceipt': base64.urlsafe_b64encode(receipt).rstrip(b'=').decode(),
                    'installerReceiptSha256': b.sha(receipt), 'state': 'evicted', 'scope': self.eviction['scope'],
                    'currentRuntimeId': self.source['runtimeId'], 'bootId': self.app.boot_id(), 'diskEpoch': self.app.epoch()}
        self.app.atomic(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.rollback.json', b.packed(self.ref))
        shutil.rmtree(self.case.runtime(source))
        self.install = source
        self.request.update(source=self.source, install=fixtures.fixture.encoded(source).decode(),
                            restore={'retentionId': self.ref['retentionId'], 'installerReceiptSha256': b.sha(receipt),
                                     'deadline': '2026-10-04T00:04:00Z'})
        self.app.downloader = self.case.download
        self.before = self.snapshot()
        self.case.host.calls.clear()
        self.runtime.authorize_restore = lambda *_: True
        return receipt

    def test_private_stage_restores_original_receipt_before_any_source_retirement(self):
        receipt = self.evicted()
        self.assertEqual(self.stage()['outcome'], 'staged')
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + self.install['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)
        self.app.verify_runtime(self.install['runtime']['runtimeId'], full=True)
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])
        self.assertEqual(self.runtime.calls, [])

    def test_post_fetch_denial_keeps_the_serving_source_and_retained_proof(self):
        receipt = self.evicted()
        allowed = True
        download = self.app.downloader

        def delayed(*args):
            nonlocal allowed
            download(*args)
            allowed = False

        self.app.downloader = delayed
        self.runtime.authorize_restore = lambda *_: allowed
        with self.assertRaises(Exception):
            self.stage()
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + self.install['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_changed_retention_receipt_refuses_before_downloading(self):
        self.evicted()
        self.request['restore']['installerReceiptSha256'] = '0' * 64
        with mock.patch.object(self.app, 'downloader', side_effect=AssertionError('not authorized')) as download:
            with self.assertRaises(Exception): self.stage()
        download.assert_not_called()

    def refuse_changed_activation(self, change):
        self.evicted()
        self.assertEqual(self.stage()['outcome'], 'staged')
        change()
        with self.assertRaises(Exception):
            self.activate()
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])
        self.assertEqual(self.runtime.calls, [])

    def test_activation_cannot_omit_the_original_restore_deadline(self):
        self.refuse_changed_activation(lambda: self.request.pop('restore'))

    def test_activation_cannot_extend_the_saved_restore_deadline(self):
        def change():
            self.app.now = lambda: datetime.datetime(2026, 10, 4, 0, 1, tzinfo=datetime.timezone.utc)
            self.request['restore']['deadline'] = '2026-10-04T00:05:00Z'
        self.refuse_changed_activation(change)

    def test_activation_cannot_rebind_a_prepared_restore_to_another_transition(self):
        self.refuse_changed_activation(lambda: self.request.update(transitionId='99999999-9999-4999-8999-999999999999'))

    def test_activation_requires_the_completed_restore_journal(self):
        self.refuse_changed_activation(lambda: self.app.unlink(b.RECEIPTS + '/' + self.install['runtime']['runtimeId'] + '.restore.json'))

    def test_restored_target_activates_with_its_original_receipt_and_remaining_budget(self):
        receipt = self.evicted()
        self.assertEqual(self.stage()['outcome'], 'staged')
        self.app.now = lambda: datetime.datetime(2026, 10, 4, 0, 1, tzinfo=datetime.timezone.utc)
        deadlines = []
        self.adapter.arm_deadline = deadlines.append
        result = self.activate()
        self.assertEqual(result['outcome'], 'healthy')
        self.assertEqual(result['active']['installerReceiptSha256'], b.sha(receipt))
        self.assertTrue(deadlines)
        self.assertTrue(all(0 < seconds <= 180 for seconds in deadlines))

    def test_restored_runtime_survives_two_cold_boots_without_reading_the_evicted_previous(self):
        receipt = self.evicted()
        self.stage()
        active = self.activate()['active']
        previous = self.app.current('previous')
        self.app.evict_previous({'scope': self.eviction['scope'], 'current': active,
                                 'expiresAt': self.eviction['expiresAt']},
                                retain=lambda _: '88888888-8888-4888-8888-888888888888', authorize=lambda _: True)
        read = self.app.read

        def metadata_only(path, *args, **kwargs):
            self.assertFalse(path.startswith(b.INFRA + '/' + previous + '/'))
            return read(path, *args, **kwargs)

        with mock.patch.object(self.app, 'read', side_effect=metadata_only), \
                mock.patch.object(self.app, 'downloader', side_effect=AssertionError('ordinary boot fetched a runtime')):
            for boot in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'):
                self.app.boot_id = lambda: boot
                self.app.boot()
                self.app.install(fixtures.fixture.encoded(self.install))
                current = json.loads(read(b.ACTIVE, 4096, 0o600))
                self.assertEqual(current['bootId'], boot)
                self.assertEqual(current['installerReceiptSha256'], b.sha(receipt))
                self.assertEqual(current['runtimeId'], active['runtimeId'])
                self.assertFalse(self.app.path(b.INFRA + '/' + previous).exists())

    def test_restore_watchdog_is_armed_before_base_validation_can_wait(self):
        self.evicted()
        deadlines = []
        self.adapter.arm_deadline = deadlines.append
        base = self.app.base

        def bounded_base():
            self.assertTrue(deadlines, 'base validation ran before the restore watchdog')
            self.assertLessEqual(deadlines[-1], 240)
            base()

        self.app.base = bounded_base
        self.assertEqual(self.stage()['outcome'], 'staged')

    def test_eviction_watchdog_is_armed_before_base_validation_can_wait(self):
        self.pair()
        deadlines = []
        base = self.app.base

        def bounded_base():
            self.assertTrue(deadlines, 'base validation ran before the stop watchdog')
            self.assertLessEqual(deadlines[-1], 60)
            base()

        self.app.base = bounded_base
        pipe = mock.Mock()
        pipe.cache_exchange.return_value = {'allow': True, 'retentionId': '77777777-7777-4777-8777-777777777777'}
        result = update.RollbackCacheInstaller(b, self.app, pipe, arm_deadline=deadlines.append).run(self.eviction)
        self.assertEqual(result['outcome'], 'evicted')

    def test_sealed_stop_adapter_joins_setup_and_update_locks_and_uses_private_ack(self):
        source, receipt = self.pair()
        events = []

        class Pipe:
            def cache_exchange(_, request, phase, offer=None):
                self.assertEqual(request, self.eviction)
                events.append(phase)
                if phase == 'retain':
                    self.assertEqual(offer['installerReceiptSha256'], b.sha(receipt))
                    return {'allow': True, 'retentionId': '77777777-7777-4777-8777-777777777777'}
                return {'allow': True}

        result = update.RollbackCacheInstaller(b, self.app, Pipe()).run(self.eviction)
        self.assertEqual(result['outcome'], 'evicted')
        self.assertEqual(events, ['retain', 'retire_authorized', 'evict_authorized'])
        self.assertFalse(self.case.runtime(source).exists())
        self.assertEqual(self.app.read(b.RECEIPTS + '/' + source['runtime']['runtimeId'] + '.json', 4096, 0o600), receipt)

    def test_cache_adapter_refuses_a_setup_lock_held_by_another_installer(self):
        source, _ = self.pair()
        pipe = mock.Mock()
        with self.adapter.setup_lock():
            with self.assertRaises(Exception):
                update.RollbackCacheInstaller(b, self.app, pipe).run(self.eviction)
        pipe.cache_exchange.assert_not_called()
        self.assertTrue(self.case.runtime(source).exists())


if __name__ == '__main__': unittest.main()
