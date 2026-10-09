"""Exercise the unchanged v4 installer through the update adapter, rootlessly."""
import copy
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[4]


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


fixture = module("base_fixture", "scripts/cloud-workspace-validation/runtime-base-v4/tests/test_bootstrap.py")
update = module("runtime_update", "apps/control-plane/src/cloud-workspaces/runtime-update-adapter.py")
b = fixture.b


class Runtime:
    def __init__(self, case):
        self.case = case
        self.calls = []
        self.busy = False
        self.target_healthy = True
        self.rollback_healthy = True
        self.rollback_allowed = True
        self.on_authorize = lambda: None

    def authorize(self, request):
        self.calls.append("authorize")
        self.on_authorize()
        return not self.busy

    def retire(self):
        self.calls.append("retire")

    def selected(self, active):
        self.calls.append("selected")

    def launch_and_health(self, active, rollback, deadline):
        self.calls.append("rollback_health" if rollback else "target_health")
        return self.rollback_healthy if rollback else self.target_healthy

    def authorize_rollback(self, request):
        self.calls.append("authorize_rollback")
        return self.rollback_allowed


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.BootstrapTests()
        self.case.setUp()
        self.case.install()
        self.app = self.case.app
        self.source = json.loads(self.app.read(b.ACTIVE, 4096, 0o600))
        self.before = self.snapshot()
        self.protected = (self.case.root / "opt/zeros-bootstrap/compatibility.json").read_bytes()
        payload, self.install, _ = fixture.fixture(extra={"worker/update.txt": b"new verified runtime\n"})
        self.app.downloader = lambda artifact, stream, descriptor: stream.write(payload)
        self.runtime = Runtime(self.case)
        self.adapter = update.RuntimeInstaller(b, self.app, self.runtime)
        self.request = {
            "schema": "zeros.runtime-update/v1", "operation": "stage",
            "transitionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "fence": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "scope": {"workspaceId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                      "organizationId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                      "sourceGeneration": 1, "candidateGeneration": 2,
                      "sourceEngineInstanceId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"},
            "expiresAt": "2026-10-04T00:10:00Z", "source": self.source,
            "mode": "bootstrap", "install": fixture.encoded(self.install).decode(),
        }
        self.case.host.calls.clear()

    def tearDown(self):
        self.case.tearDown()

    def snapshot(self):
        return {name: os.readlink(self.app.path(name)) if self.app.path(name).is_symlink()
                else self.app.path(name).read_bytes() if self.app.path(name).exists() else None
                for name in (b.FACADE + "/current", b.FACADE + "/previous", b.FACADE + "/disk-epoch", b.ACTIVE)}

    def stage(self):
        return self.adapter.run(self.request)

    def activate(self, mode="bootstrap"):
        request = {key: value for key, value in self.request.items() if key != "install"}
        request.update(operation="activate", mode=mode, target=self.install["runtime"])
        return self.adapter.run(request)

    def verify_supervisor_selection(self, expected):
        source = (ROOT / "scripts/cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs").read_text()
        program = source.split("const VERIFY_SELECTED_RUNTIME = `", 1)[1].split("`;", 1)[0]
        # Exercise the shipped verification body against the real protected
        # installer with a temporary fixture root, replacing only its loader.
        body = "try:" + program.split("\ntry:", 1)[1]
        output = io.StringIO()
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(expected).encode()))
        with mock.patch.object(b, "Bootstrap", return_value=self.app), mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(output):
            exec(body, {"b": b, "sys": sys, "json": json})
        return json.loads(output.getvalue())

    def test_supervisor_selection_returns_the_verified_install_identity(self):
        self.assertEqual(self.verify_supervisor_selection(self.source), self.source)

    def test_supervisor_selection_rejects_matching_descriptor_with_tampered_tree(self):
        file = self.case.runtime() / "worker/data.txt"
        file.chmod(0o755)
        file.write_bytes(b"x" * file.stat().st_size)
        file.chmod(0o555)
        with self.assertRaises(SystemExit) as failure:
            self.verify_supervisor_selection(self.source)
        self.assertEqual(failure.exception.code, 1)

    def test_supervisor_selection_does_not_echo_an_unverified_cgroup(self):
        active = dict(self.source, cgroupRoot="/sys/fs/cgroup/other.slice/zeros-host.service")
        self.app.atomic(b.ACTIVE, json.dumps(active).encode())
        with self.assertRaises(SystemExit) as failure:
            self.verify_supervisor_selection(active)
        self.assertEqual(failure.exception.code, 1)

    def test_stage_verifies_and_preserves_source_without_host_or_hooks(self):
        self.assertEqual(self.stage()["outcome"], "staged")
        self.app.verify_runtime(self.install["runtime"]["runtimeId"], full=True)
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])
        self.assertEqual(self.runtime.calls, [])
        self.assertEqual((self.case.root / "opt/zeros-bootstrap/compatibility.json").read_bytes(), self.protected)

    def test_cached_target_tampering_fails_without_source_change(self):
        self.stage()
        file = self.case.runtime(self.install) / "worker/update.txt"
        file.chmod(0o755)
        file.write_bytes(b"corrupt target\n")
        file.chmod(0o555)
        with self.assertRaises(Exception):
            self.stage()
        with self.assertRaises(Exception):
            self.activate()
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])
        self.assertEqual(self.runtime.calls, [])

    def test_recovery_residue_cannot_stop_or_reconcile_running_source(self):
        self.app.atomic(b.RECEIPTS + "/switch-intent.json", b"{}")
        with self.assertRaises(Exception):
            self.stage()
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])

    def test_workspace_setup_payload_is_rejected(self):
        value = copy.deepcopy(self.install)
        value.update(purpose="workspace-setup", setup="e30")
        self.request["install"] = fixture.encoded(value).decode()
        with self.assertRaises(Exception):
            self.stage()
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])

    def test_busy_cancels_at_final_decision_before_any_retirement(self):
        self.stage()
        self.runtime.busy = True
        self.assertEqual(self.activate()["outcome"], "deferred")
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])
        self.assertEqual(self.runtime.calls, ["authorize"])

    def test_source_session_change_after_authorization_cancels(self):
        self.stage()
        self.runtime.on_authorize = lambda: self.app.activate(self.source["runtimeId"], b.CGROUP)
        with self.assertRaises(Exception):
            self.activate()
        self.assertEqual(self.app.current(), self.source["runtimeId"])
        self.assertEqual(self.case.host.calls, [])

    def test_bootstrap_restarts_host_once_then_checks_target_health(self):
        self.stage()
        result = self.activate()
        self.assertEqual(result["outcome"], "healthy")
        self.assertEqual(self.app.current(), self.install["runtime"]["runtimeId"])
        self.assertEqual(self.case.host.calls, ["stop", "start"])
        self.assertEqual(self.runtime.calls, ["authorize", "selected", "target_health"])
        self.assertEqual(result["active"]["baseCompatibilityId"], self.source["baseCompatibilityId"])
        self.assertEqual(result["active"]["bootId"], self.source["bootId"])
        self.assertNotEqual(result["active"]["supervisorSessionId"], self.source["supervisorSessionId"])

    def test_engine_activation_keeps_host_alive(self):
        self.stage()
        self.assertEqual(self.activate("engine")["outcome"], "healthy")
        self.assertEqual(self.case.host.calls, [])
        self.assertEqual(self.runtime.calls, ["authorize", "retire", "selected", "target_health"])

    def test_target_health_failure_restores_verified_source_and_fresh_identity(self):
        self.stage()
        timer = mock.Mock()
        self.adapter.arm_deadline = timer
        self.runtime.target_healthy = False
        result = self.activate()
        self.assertEqual(result["outcome"], "rolled_back")
        self.assertEqual(self.app.current(), self.source["runtimeId"])
        self.assertNotEqual(result["active"]["supervisorSessionId"], self.source["supervisorSessionId"])
        self.assertEqual(self.case.host.calls, ["stop", "start", "stop", "start"])
        self.assertEqual(self.runtime.calls[-3:], ["authorize_rollback", "selected", "rollback_health"])
        self.assertEqual(timer.call_args_list, [mock.call(240), mock.call(240)])

    def test_unknown_authority_does_not_resurrect_source(self):
        self.stage()
        self.runtime.target_healthy = False
        self.runtime.rollback_allowed = False
        result = self.activate()
        self.assertEqual(result["outcome"], "recovery_required")
        self.assertEqual(self.app.current(), self.install["runtime"]["runtimeId"])
        self.assertNotIn("rollback_health", self.runtime.calls)

    def test_failed_rollback_is_closed_and_journal_has_no_install_url(self):
        self.stage()
        self.runtime.target_healthy = False
        self.runtime.rollback_healthy = False
        self.assertEqual(self.activate()["outcome"], "recovery_required")
        journal = self.app.read(update.JOURNAL, 16384, 0o600).decode()
        self.assertNotIn("https:", journal)
        self.assertNotIn("artifact", journal)
        self.assertEqual(json.loads(journal)["phase"], "recovery_required")

    def test_expired_intent_and_base_mismatch_are_rejected(self):
        for change in ({"expiresAt": "2026-10-03T00:00:00Z"},
                       {"source": {**self.source, "baseCompatibilityId": "bc1-" + "a" * 64}}):
            with self.assertRaises(Exception):
                self.adapter.run({**self.request, **change})
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])

    def test_partial_pointer_publication_rolls_back(self):
        self.stage()
        failed = False

        def fault(point):
            nonlocal failed
            if point == "current_published" and not failed:
                failed = True
                raise b.Failure("pointer_publish")

        self.app.fault = fault
        self.assertEqual(self.activate()["outcome"], "rolled_back")
        self.assertEqual(self.app.current(), self.source["runtimeId"])
        self.assertFalse(self.app.path(b.RECEIPTS + "/switch-intent.json").exists())

    def test_crash_journal_blocks_an_ordinary_retry(self):
        self.stage()
        self.app.fault = lambda point: (_ for _ in ()).throw(fixture.Crash()) if point == "current_published" else None
        with self.assertRaises(fixture.Crash):
            self.activate()
        calls = self.case.host.calls[:]
        self.assertEqual(json.loads(self.app.read(update.JOURNAL, 16384, 0o600))["phase"], "activating")
        with self.assertRaises(Exception):
            self.activate()
        self.assertEqual(self.case.host.calls, calls)

    def test_corrupted_saved_runtime_is_not_launched_during_rollback(self):
        self.stage()
        self.runtime.target_healthy = False

        def corrupt(_):
            file = self.case.runtime() / "worker/data.txt"
            file.chmod(0o755)
            file.write_bytes(b"corrupted source\n")
            file.chmod(0o555)
            return True

        self.runtime.authorize_rollback = corrupt
        self.assertEqual(self.activate()["outcome"], "recovery_required")
        self.assertNotIn("rollback_health", self.runtime.calls)

    def test_system_bootstrap_refuses_a_second_host_restart(self):
        pipe = mock.Mock()
        runtime = update.SystemRuntime(b, self.app, pipe, self.request)
        runtime.check_source_scope = lambda: None
        runtime.supervisor = lambda _: {"outcome": "ready", "controller": self.source, "selected": self.source}
        with self.assertRaises(Exception):
            runtime.authorize(self.request)
        pipe.exchange.assert_not_called()

    def test_system_engine_authorization_binds_the_resident_controller(self):
        pipe = mock.Mock()
        pipe.exchange.return_value = {"allow": True}
        request = {**self.request, "mode": "engine"}
        runtime = update.SystemRuntime(b, self.app, pipe, request)
        runtime.check_source_scope = lambda: None
        runtime.supervisor = lambda _: {"outcome": "ready", "controller": self.source, "selected": self.source}
        self.assertTrue(runtime.authorize(request))
        pipe.exchange.assert_called_once_with(request, "authorize", controller=self.source)

    def resident_fixture(self):
        scope = self.request["scope"]
        handoff = {"challenge": "abababab-abab-4bab-8bab-abababababab", "workspaceId": scope["workspaceId"],
                   "organizationId": scope["organizationId"], "generation": scope["sourceGeneration"],
                   "engineInstanceId": scope["sourceEngineInstanceId"], "hostId": "ffffffff-ffff-4fff-8fff-ffffffffffff",
                   "fence": 1, "expiresAtMs": int(self.app.now().timestamp() * 1000) + 60_000}
        resident = {"hostId": handoff["hostId"], "organizationId": scope["organizationId"], "workspaceId": scope["workspaceId"],
                    "protocol": "zeros.resident-pty/v1", **{key: self.source[key] for key in
                    ("runtimeId", "manifestSha256", "bootId", "supervisorSessionId")},
                    "scope": b.CGROUP + "/engine-workload-" + handoff["hostId"], "fence": 1,
                    "engineId": scope["sourceEngineInstanceId"], "generation": 1}
        request = {**self.request, "mode": "engine", "handoff": handoff}
        pipe = mock.Mock()
        pipe.exchange.return_value = {"allow": True}
        runtime = update.SystemRuntime(b, self.app, pipe, request)
        runtime.check_source_scope = lambda: None
        runtime.check_retired_scope = lambda: None
        receipt = {**handoff, "version": 1, "phase": "fenced", "activityRevision": 7}
        detached = {**resident, "fence": 2, "engineId": None, "generation": None}
        def supervisor(operation, **fields):
            if operation == "update-status":
                return {"outcome": "ready", "controller": self.source, "selected": self.source}
            if operation == "resident-status":
                return {"outcome": "ready", "resident": resident}
            if operation == "runtime-handoff":
                return {"outcome": "fenced", "handoff": receipt}
            if operation == "prepare":
                self.assertEqual(fields, {"resident": {"hostId": handoff["hostId"], "engineId": handoff["engineInstanceId"], "fence": 1},
                                          "handoff": handoff})
                return {"outcome": "prepared", "session": "zsp_" + "a" * 43, "resident": detached}
            self.fail("Unexpected supervisor operation")
        runtime.supervisor = mock.Mock(side_effect=supervisor)
        return runtime, request, pipe, resident, detached, receipt

    def test_resident_consumption_precedes_source_authority_retirement(self):
        runtime, request, pipe, resident, detached, receipt = self.resident_fixture()
        self.assertTrue(runtime.authorize(request))
        pipe.exchange.assert_called_once_with(request, "authorize_consumption", controller=self.source, resident=resident, handoff=receipt)
        self.assertNotIn(mock.call("prepare"), runtime.supervisor.call_args_list)
        runtime.retire()
        self.assertEqual(runtime.resident, detached)
        self.assertEqual(pipe.exchange.call_args_list[-1], mock.call(request, "consumed", resident=detached))

    def test_resident_lost_prepare_reply_retries_only_the_identical_handoff(self):
        runtime, request, pipe, _, detached, _ = self.resident_fixture()
        self.assertTrue(runtime.authorize(request))
        original = runtime.supervisor.side_effect
        attempts = []
        def fail_once(operation, **fields):
            if operation == "prepare":
                attempts.append(fields)
                if len(attempts) == 1:
                    raise TimeoutError()
            return original(operation, **fields)
        runtime.supervisor.side_effect = fail_once
        runtime.retire()
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(runtime.resident, detached)
        self.assertEqual(pipe.exchange.call_args_list[-1], mock.call(request, "consumed", resident=detached))

    def test_resident_ambiguous_consumption_never_falls_back_to_ordinary_prepare(self):
        runtime, request, pipe, _, _, _ = self.resident_fixture()
        self.assertTrue(runtime.authorize(request))
        runtime.supervisor.reset_mock(side_effect=True)
        runtime.supervisor.side_effect = TimeoutError()
        with self.assertRaises(update.UpdateFailure):
            runtime.retire()
        self.assertTrue(runtime.supervisor.call_args_list)
        self.assertTrue(all(call.kwargs.get("handoff") == request["handoff"] for call in runtime.supervisor.call_args_list))
        self.assertEqual(pipe.exchange.call_count, 1)

    def test_resident_scope_preserves_only_the_exact_attested_workload(self):
        runtime, _, _, resident, _, _ = self.resident_fixture()
        root = fixture.cgroup_fixture(self.case.root)
        workload = root / ("engine-workload-" + resident["hostId"])
        workload.mkdir()
        (workload / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        runtime.resident = resident
        runtime.check_scope(retired=False)
        runtime.check_scope(retired=True)
        engine = root / ("engine-" + self.request["scope"]["sourceEngineInstanceId"])
        engine.mkdir()
        (engine / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        runtime.check_scope(retired=False)
        with self.assertRaises(update.UpdateFailure):
            runtime.check_scope(retired=True)
        (engine / "cgroup.events").write_text("populated 0\nfrozen 0\n")
        (workload / "unexpected").mkdir()
        with self.assertRaises(update.UpdateFailure):
            runtime.check_scope(retired=True)

    def test_resident_scope_rejects_a_populated_foreign_workload(self):
        runtime, _, _, resident, _, _ = self.resident_fixture()
        root = fixture.cgroup_fixture(self.case.root)
        foreign = root / "engine-workload-11111111-1111-4111-8111-111111111111"
        foreign.mkdir()
        (foreign / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        runtime.resident = resident
        for retired in (False, True):
            with self.subTest(retired=retired), self.assertRaises(update.UpdateFailure):
                runtime.check_scope(retired=retired)

    def test_resident_document_rejects_foreign_wrong_prefix_and_nested_scopes(self):
        _, _, _, resident, _, _ = self.resident_fixture()
        for scope in (b.CGROUP + "/engine-workload-11111111-1111-4111-8111-111111111111",
                      b.CGROUP + "/workload-" + resident["hostId"], resident["scope"] + "/nested",
                      b.CGROUP + "/engine-runtime/engine-workload-11111111-1111-4111-8111-111111111111",
                      b.CGROUP + "/engine-runtime/engine-" + resident["hostId"],
                      b.CGROUP + "/engine-runtime/engine-workload-shared/workload",
                      b.CGROUP + "/engine-runtime", b.CGROUP,
                      b.CGROUP + "/engine-runtime/engine-workload-" + resident["hostId"] + "/nested",
                      b.CGROUP + "/engine-runtime/engine-workload-" + resident["hostId"] + "/",
                      b.CGROUP + "/engine-runtime/../engine-workload-" + resident["hostId"],
                      "/sys/fs/cgroup/foreign.service/engine-runtime/engine-workload-" + resident["hostId"]):
            with self.subTest(scope=scope), self.assertRaises(update.UpdateFailure):
                update.resident_document(b, {**resident, "scope": scope})

    def test_resident_document_accepts_only_exact_current_and_legacy_controller_scopes(self):
        _, _, _, resident, _, _ = self.resident_fixture()
        for scope in (resident["scope"], b.CGROUP + "/engine-runtime/engine-workload-" + resident["hostId"]):
            attached = {**resident, "scope": scope}
            detached = {**attached, "engineId": None, "generation": None, "fence": 2}
            for value in (attached, detached):
                with self.subTest(scope=scope, detached=value["engineId"] is None):
                    self.assertIs(update.resident_document(b, value), value)
            other_scope = resident["scope"] if scope != resident["scope"] else b.CGROUP + "/engine-runtime/engine-workload-" + resident["hostId"]
            self.assertFalse(update.same_resident(attached, {**detached, "scope": other_scope}))

    def test_resident_foreign_witness_and_unfenced_receipt_cannot_authorize_consumption(self):
        for change in ("resident", "receipt"):
            runtime, request, pipe, resident, _, receipt = self.resident_fixture()
            if change == "resident":
                resident["workspaceId"] = resident["hostId"]
            else:
                receipt["challenge"] = receipt["hostId"]
            with self.assertRaises(update.UpdateFailure):
                runtime.authorize(request)
            pipe.exchange.assert_not_called()
            self.assertFalse(any(call.args[0] == "prepare" for call in runtime.supervisor.call_args_list))

    def test_resident_consumption_denial_keeps_the_pointer_and_never_stops_the_host(self):
        self.stage()
        runtime, request, pipe, _, _, _ = self.resident_fixture()
        request = {key: value for key, value in request.items() if key != "install"}
        request.update(operation="activate", target=self.install["runtime"])
        runtime.request = request
        pipe.exchange.side_effect = lambda _request, phase, **_fields: {"allow": phase != "consumed"}
        adapter = update.RuntimeInstaller(b, self.app, runtime)
        self.assertEqual(adapter.run(request)["outcome"], "recovery_required")
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])
        self.assertEqual([call.args[1] for call in pipe.exchange.call_args_list], ["authorize_consumption", "consumed"])
        journal = json.loads(self.app.read(update.JOURNAL, 16384, 0o600))
        self.assertEqual(journal["phase"], "recovery_required")
        self.assertEqual(journal["handoff"], request["handoff"])
        self.assertNotIn("session", journal)

    def test_resident_busy_recheck_requires_confirmed_cancellation_before_deferring(self):
        runtime, request, pipe, resident, _, _ = self.resident_fixture()
        self.assertTrue(runtime.authorize(request))
        original = runtime.supervisor.side_effect
        def supervisor(operation, **fields):
            if operation == "prepare":
                return {"outcome": "rejected"}
            if operation == "runtime-handoff" and fields.get("action") == "cancel":
                return {"outcome": "cancelled"}
            return original(operation, **fields)
        runtime.supervisor.side_effect = supervisor
        with self.assertRaises(update.Deferred):
            runtime.retire()
        self.assertEqual(pipe.exchange.call_args_list[-1], mock.call(request, "cancel_consumption", resident=resident))
        self.assertIsNone(runtime.session)

    def test_resident_rollback_detaches_only_the_enrolled_target_and_keeps_its_host(self):
        runtime, request, pipe, _, detached, _ = self.resident_fixture()
        self.assertTrue(runtime.authorize(request))
        runtime.retire()
        target = {**detached, "fence": 3, "engineId": "abababab-abab-4bab-8bab-abababababab", "generation": 2}
        runtime.resident_enrollment = {key: target[key] for key in ("engineId", "generation", "fence")}
        def supervisor(operation, **fields):
            if operation == "resident-status":
                return {"outcome": "ready", "resident": target}
            self.assertEqual(operation, "prepare")
            self.assertEqual(fields, {"resident": {key: target[key] for key in ("hostId", "engineId", "fence")}})
            return {"outcome": "prepared", "session": "zsp_" + "b" * 43,
                    "resident": {**detached, "fence": 4}}
        runtime.supervisor = supervisor
        runtime.retire()
        self.assertEqual(runtime.resident, {**detached, "fence": 4})
        self.assertEqual(pipe.exchange.call_count, 2)

    def resident_start_fixture(self, outcome, *, changed_session=False):
        runtime, request, pipe, _, detached, _ = self.resident_fixture()
        self.assertTrue(runtime.authorize(request))
        runtime.retire()
        target_id = "abababab-abab-4bab-8bab-abababababab"
        execution = {key: request["scope"][key] for key in ("workspaceId", "organizationId")}
        environment = {"runtimeB64": fixture.encoded({"version": 1, "audience": "zeros-cloud-engine-runtime-v1",
            "execution": {**execution, "generation": 2}, "engine": {"instanceId": target_id}}).decode()}
        pipe.exchange.return_value = {"allow": True, "environment": environment}
        operations, prepares = [], []
        attached = {**detached, "engineId": target_id, "generation": 2, "fence": 3}
        original_session = runtime.session
        def supervisor(operation, **fields):
            operations.append(operation)
            if operation == "start":
                if outcome == "timeout":
                    raise TimeoutError()
                return {"outcome": "failed" if outcome.startswith("failed") else "rejected"}
            if operation == "resident-status":
                return {"outcome": "ready", "resident": attached if outcome == "failed_attached" else detached}
            self.assertEqual(operation, "prepare")
            prepares.append(fields)
            if outcome == "failed_attached":
                self.assertEqual(fields, {"resident": {key: attached[key] for key in ("hostId", "engineId", "fence")}})
                return {"outcome": "prepared", "session": original_session, "resident": {**detached, "fence": 4}}
            self.assertEqual(fields, {"resident": {"hostId": request["handoff"]["hostId"],
                "engineId": request["handoff"]["engineInstanceId"], "fence": 1}, "handoff": request["handoff"]})
            return {"outcome": "prepared", "session": "zsp_" + "c" * 43 if changed_session else original_session,
                    "resident": detached}
        runtime.supervisor = supervisor
        read_fd, write_fd = os.pipe()
        report = {"version": 2, "boundary": "workspace-vm", "profile": "zeros-cloud-worker-v4", "qualified": True, "runtime": self.source}
        diagnostic = {"schema": "zeros.diagnostic/v1", "component": "attester", "ok": True,
                      "stage": "done", "exitCode": 0, "failedChecks": []}
        os.write(write_fd, b.packed(report) + b"\n" + b.packed(diagnostic) + b"\n")
        os.close(write_fd)
        child = mock.Mock(stdout=os.fdopen(read_fd, "rb"))
        child.wait.return_value = 0
        with mock.patch.object(update.subprocess, "Popen", return_value=child):
            with self.assertRaises(Exception):
                runtime.launch_and_health(self.source, False, update.time.monotonic() + 10)
        return runtime, detached, operations, prepares

    def test_proven_pre_attachment_rejection_reuses_only_the_original_unspent_prepare(self):
        runtime, detached, operations, prepares = self.resident_start_fixture("rejected")
        runtime.retire()
        self.assertIsNone(runtime.resident_enrollment)
        self.assertEqual(runtime.resident, detached)
        self.assertIsNotNone(runtime.session)
        self.assertEqual(operations[:3], ["start", "resident-status", "prepare"])
        self.assertEqual(len(prepares), 2)
        self.assertEqual(prepares[0], prepares[1])

    def test_unchanged_detached_host_without_the_original_session_cannot_roll_back(self):
        runtime, _, _, _ = self.resident_start_fixture("rejected", changed_session=True)
        with self.assertRaises(Exception):
            runtime.retire()
        self.assertIsNotNone(runtime.resident_enrollment)
        self.assertIsNone(runtime.session)

    def test_failed_or_lost_start_never_infers_an_unattached_target(self):
        for outcome in ("failed_detached", "timeout"):
            with self.subTest(outcome=outcome):
                runtime, _, _, prepares = self.resident_start_fixture(outcome)
                with self.assertRaises(Exception):
                    runtime.retire()
                self.assertIsNotNone(runtime.resident_enrollment)
                self.assertEqual(prepares, [])

    def test_failed_start_after_attachment_retires_only_the_exact_target(self):
        runtime, detached, _, prepares = self.resident_start_fixture("failed_attached")
        runtime.retire()
        self.assertIsNone(runtime.resident_enrollment)
        self.assertEqual(runtime.resident, {**detached, "fence": 4})
        self.assertEqual(len(prepares), 1)

    def test_expiration_during_final_decision_cannot_retire(self):
        self.stage()
        self.runtime.on_authorize = lambda: setattr(self.app, "now", lambda: fixture.NOW + fixture.datetime.timedelta(minutes=20))
        with self.assertRaises(Exception):
            self.activate()
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])

    def test_install_and_update_locks_cannot_overlap_an_ordinary_setup(self):
        for lock in ("setup.lock", "runtime-install.lock", "runtime-update.lock"):
            with self.app.lock(lock):
                with self.assertRaises(Exception):
                    self.stage()
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.case.host.calls, [])

    def test_existing_flock_created_setup_lock_can_be_reused_without_chmod(self):
        lock = self.app.path("/run/zeros/setup.lock")
        lock.touch(mode=0o644)
        lock.chmod(0o644)
        self.assertEqual(self.stage()["outcome"], "staged")
        self.assertEqual(lock.stat().st_mode & 0o777, 0o644)

    def test_unsafe_setup_lock_is_rejected_before_staging(self):
        lock = self.app.path("/run/zeros/setup.lock")
        lock.touch(mode=0o666)
        lock.chmod(0o666)
        with self.assertRaises(Exception):
            self.stage()
        self.assertFalse(self.case.runtime(self.install).exists())

    def test_enrollment_is_bound_to_workspace_generation_and_fresh_engine(self):
        scope = self.request["scope"]
        value = {"version": 1, "audience": "zeros-cloud-engine-runtime-v1",
                 "execution": {"workspaceId": scope["workspaceId"], "organizationId": scope["organizationId"], "generation": 2},
                 "engine": {"instanceId": "ffffffff-ffff-4fff-8fff-ffffffffffff"}}
        environment = lambda data: {"runtimeB64": fixture.encoded(data).decode()}
        update.validate_enrollment_environment(b, environment(value), self.request, False)
        for change in ({"generation": 1}, {"organizationId": scope["workspaceId"]}, {"workspaceId": scope["organizationId"]}):
            invalid = {**value, "execution": {**value["execution"], **change}}
            with self.assertRaises(Exception):
                update.validate_enrollment_environment(b, environment(invalid), self.request, False)
        invalid = {**value, "engine": {"instanceId": scope["sourceEngineInstanceId"]}}
        with self.assertRaises(Exception):
            update.validate_enrollment_environment(b, environment(invalid), self.request, False)
        with self.assertRaises(Exception):
            update.validate_enrollment_environment(b, environment(value), self.request, True)
        restored = {**value, "execution": {**value["execution"], "generation": 1}}
        update.validate_enrollment_environment(b, environment(restored), self.request, True)

    def test_source_scope_rejects_another_live_engine_and_unknown_population(self):
        root = fixture.cgroup_fixture(self.case.root)
        allowed = root / ("engine-" + self.request["scope"]["sourceEngineInstanceId"])
        allowed.mkdir()
        (allowed / "cgroup.events").write_text("populated 1\nfrozen 0\n")
        other = root / "engine-ffffffff-ffff-4fff-8fff-ffffffffffff"
        other.mkdir()
        events = other / "cgroup.events"
        runtime = update.SystemRuntime(b, self.app, mock.Mock(), self.request)
        events.write_text("populated 0\nfrozen 0\n")
        runtime.check_source_scope()
        for invalid in ("populated 1\nfrozen 0\n", "", "populated unknown\n"):
            events.write_text(invalid)
            with self.assertRaises(Exception):
                runtime.check_source_scope()

    def test_rollback_enrollment_never_reuses_the_candidate_proof_epoch(self):
        scope = self.request["scope"]
        candidate = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        value = {"version": 1, "audience": "zeros-cloud-engine-runtime-v1",
                 "execution": {"workspaceId": scope["workspaceId"], "organizationId": scope["organizationId"], "generation": 1},
                 "engine": {"instanceId": candidate}}
        environment = lambda data: {"runtimeB64": fixture.encoded(data).decode()}
        with self.assertRaises(Exception):
            update.validate_enrollment_environment(b, environment(value), self.request, True, {candidate})
        fresh = "abababab-abab-4bab-8bab-abababababab"
        value["engine"]["instanceId"] = fresh
        self.assertEqual(update.validate_enrollment_environment(b, environment(value), self.request, True, {candidate}), fresh)

    def test_controller_restart_during_engine_selection_fails_closed(self):
        runtime = update.SystemRuntime(b, self.app, mock.Mock(), {**self.request, "mode": "engine"})
        runtime.controller = self.source
        runtime.supervisor = lambda operation, **_: ({"outcome": "selected"} if operation == "select-runtime"
            else {"outcome": "ready", "selected": self.source,
                  "controller": {**self.source, "supervisorSessionId": "ffffffff-ffff-4fff-8fff-ffffffffffff"}})
        with self.assertRaises(Exception):
            runtime.selected(self.source)

    def test_bootstrap_candidate_must_support_engine_selection(self):
        request = {**self.request, "target": self.install["runtime"]}
        runtime = update.SystemRuntime(b, self.app, mock.Mock(), request)
        runtime.wait_for_supervisor = lambda _active: None
        runtime.retire = lambda: None
        runtime.supervisor = lambda *_args, **_fields: {"outcome": "rejected"}
        target = {**self.source, **{key: request["target"][key] for key in ("runtimeId", "manifestSha256")},
                  "root": b.INFRA + "/" + request["target"]["runtimeId"]}
        with self.assertRaises(Exception):
            runtime.selected(target)

    def test_bootstrap_waits_for_the_new_supervisor_socket_before_preparing(self):
        runtime = update.SystemRuntime(b, self.app, mock.Mock(), self.request)
        runtime.retire = mock.Mock()
        attempts = []

        def supervisor(operation, **_fields):
            if operation == "status":
                attempts.append(operation)
                if len(attempts) < 3:
                    raise ConnectionRefusedError()
                return {"outcome": "ready"}
            return {"outcome": "ready", "selected": self.source, "controller": self.source}

        runtime.supervisor = supervisor
        with mock.patch.object(update.time, "sleep"):
            runtime.selected(self.source)
        self.assertEqual(len(attempts), 3)
        runtime.retire.assert_called_once()

    def test_bootstrap_readiness_wait_is_bounded_before_preparation(self):
        runtime = update.SystemRuntime(b, self.app, mock.Mock(), self.request)
        runtime.retire = mock.Mock()
        runtime.supervisor = mock.Mock(side_effect=ConnectionRefusedError())
        with mock.patch.object(update.time, "monotonic", side_effect=[0, 31]), mock.patch.object(update.time, "sleep"):
            with self.assertRaises(Exception):
                runtime.selected(self.source)
        runtime.retire.assert_not_called()


if __name__ == "__main__":
    unittest.main()
