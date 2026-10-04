"""Operator probes retain closed evidence without shortening hydration readiness."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime = load("runtime_probe")
persistence = load("persistence_probe")


class LiveProbeTests(unittest.TestCase):
    def test_runtime_probe_starts_active_wait_only_after_slow_hydration(self):
        with tempfile.TemporaryDirectory() as directory:
            active = Path(directory) / "active.json"
            clock, events = [0], []
            descriptor = {"runtimeId": "fixture", "bootId": "boot", "supervisorSessionId": "session", "installerReceiptSha256": "receipt"}

            def wait_ready():
                events.append("ready")
                clock[0] += 400  # Longer than the old unit timeout and the ACTIVE wait.

            def sleep(seconds):
                self.assertGreaterEqual(clock[0], 400)
                clock[0] += seconds
                if clock[0] >= 401:
                    active.write_text(json.dumps(descriptor))

            def verify(_rid, full):
                self.assertTrue(full)
                self.assertTrue(active.exists(), "hydration consumed the active-descriptor wait")
                events.append("verify")
                clock[0] += 2
                return {"files": [{"type": "file", "size": 6}, {"type": "symlink"}]}, b"receipt"

            b = types.SimpleNamespace(ACTIVE=str(active), INFRA="/fixture", ENV={}, sha=lambda _raw: "receipt")
            app = types.SimpleNamespace(base=lambda: events.append("base"), wait_ready=wait_ready,
                                        current=lambda pointer="current": "fixture" if pointer == "current" else None,
                                        verify_runtime=verify, read=lambda *_args: active.read_bytes(), boot_id=lambda: "boot",
                                        status=lambda: {"hostState": "idle"})
            with mock.patch.object(runtime.time, "monotonic", side_effect=lambda: clock[0]), \
                 mock.patch.object(runtime.time, "sleep", side_effect=sleep), \
                 mock.patch.object(runtime.subprocess, "run", return_value=types.SimpleNamespace(stdout=b'{"node":"22.23.1","abi":"127"}')) as run:
                result = runtime.probe(b, app, "fixture", False)
            self.assertEqual(events, ["ready", "base", "verify"])
            self.assertGreater(clock[0], 401)
            self.assertEqual(result["fullRehashMs"], 2000)
            self.assertEqual(result["fileCount"], 1)
            self.assertEqual(result["previous"], None)
            self.assertEqual(run.call_args.kwargs["timeout"], 10)

    def test_persistence_probe_checks_base_only_after_unit_readiness(self):
        events = []
        app = types.SimpleNamespace(wait_ready=lambda: events.append("ready"), base=lambda: events.append("base"),
                                    persistence=mock.Mock(side_effect=RuntimeError("stop after preflight")))
        with self.assertRaises(RuntimeError):
            persistence.probe(app, "cold")
        self.assertEqual(events, ["ready", "base"])

    def test_both_probe_entrypoints_retain_original_failure_even_if_private_logger_fails(self):
        for module, argument in ((runtime, "fixture"), (persistence, "verify")):
            for logger_fails in (False, True):
                with self.subTest(module=module.__name__, logger_fails=logger_fails):
                    app = types.SimpleNamespace(base=lambda: None, log_failure=mock.Mock(side_effect=OSError("private-canary") if logger_fails else None))
                    bootstrap = types.SimpleNamespace(Bootstrap=lambda: app)
                    spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _module: None))
                    output = io.StringIO()
                    with mock.patch.object(module.importlib.util, "spec_from_file_location", return_value=spec), \
                         mock.patch.object(module.importlib.util, "module_from_spec", return_value=bootstrap), \
                         mock.patch.object(module, "probe", side_effect=subprocess.TimeoutExpired(["private-canary"], 10)), \
                         contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
                        module.main(argument)
                    lines = [json.loads(line) for line in output.getvalue().splitlines()]
                    self.assertEqual(stopped.exception.code, 1)
                    self.assertEqual(len(lines), 2)
                    self.assertEqual(set(lines[0]), {"schema", "exception", "line"})
                    self.assertEqual(lines[0]["exception"], "TimeoutExpired")
                    self.assertGreater(lines[0]["line"], 0)
                    self.assertEqual(lines[-1]["schema"], "zeros.diagnostic/v1")
                    self.assertEqual(lines[-1]["exitCode"], 1)
                    self.assertNotIn("private-canary", output.getvalue())
                    app.log_failure.assert_called_once()

    def test_probe_failures_do_not_record_arbitrary_exception_names_or_messages(self):
        error = type("private-canary", (Exception,), {})("private-canary")
        for module in (runtime, persistence):
            self.assertEqual(module.probe_failure(error), {
                "schema": "zeros.live-probe-failure/v1", "exception": "Exception", "line": 0,
            })

    def test_agent_child_failure_keeps_original_probe_site_instead_of_waitpid_assertion(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(persistence.os, "setgroups"), \
             mock.patch.object(persistence.os, "setgid"), \
             mock.patch.object(persistence.os, "setuid"):
            persistence.tree_operation("seed", Path(directory))
            (Path(directory) / "same-before/nested/before.txt").unlink()
            with self.assertRaises(Exception) as stopped:
                persistence.as_agent(os.getuid() + 1, os.getgid(), "rename", Path(directory))
            result = persistence.probe_failure(stopped.exception)
        lines = Path(persistence.__file__).read_text().splitlines()
        expected = next(index + 1 for index, line in enumerate(lines) if 'assert (root / before / "nested/before.txt").read_text()' in line)
        self.assertEqual(result["exception"], "FileNotFoundError")
        self.assertEqual(result["line"], expected)

    def test_agent_child_returns_all_rename_results_without_hiding_missing_files(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(persistence.os, "setgroups"), \
             mock.patch.object(persistence.os, "setgid"), \
             mock.patch.object(persistence.os, "setuid"):
            root = Path(directory)
            persistence.as_agent(os.getuid() + 1, os.getgid(), "seed", root)
            persistence.as_agent(os.getuid() + 1, os.getgid(), "rename", root)
            (root / "same-after/nested/before.txt").unlink()
            checks = persistence.as_agent(os.getuid() + 1, os.getgid(), "verify", root)
            self.assertEqual(len(checks), 6)
            self.assertFalse(checks["same_parent_seed_intact"])
            self.assertTrue(checks["cross_parent_seed_intact"])
