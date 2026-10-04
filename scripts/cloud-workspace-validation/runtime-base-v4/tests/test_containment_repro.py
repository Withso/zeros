import importlib.util
import json
import pathlib
import unittest
from unittest import mock


SOURCE = pathlib.Path(__file__).resolve().parents[1] / "containment_repro.py"
SPEC = importlib.util.spec_from_file_location("containment_repro", SOURCE)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class ContainmentReproTests(unittest.TestCase):
    def test_qualification_uses_self_test_identity_namespace_and_environment(self):
        root = "/opt/zeros-infra/r1-" + "a" * 64
        home = "/run/zeros/runtime-smoke-fixture"
        with mock.patch.object(probe, "capture", return_value={"stdout": json.dumps({
                "version": 1, "secure": False, "identity": {"secure": False},
                "workload": None, "capture": None, "humanServices": None, "actorTools": None}),
                "stderr": "", "exitCode": 1}) as run:
            result = probe.qualify(root, home, False)
        command, environment = run.call_args.args[:2]
        self.assertEqual(command[:4], ["/usr/bin/unshare", "--net", "--", "/usr/bin/python3"])
        self.assertEqual(command[4:6], ["-I", "-c"])
        self.assertIn("0x8914", command[6])
        self.assertIn("b'lo',1", command[6])
        self.assertIn(root + "/bin/node", command[6])
        self.assertIn(root + "/lib/zeros/cloud-engine-launcher.mjs", command[6])
        self.assertIn("--qualify", command[6])
        self.assertEqual(environment, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": home, "TMPDIR": home})
        self.assertFalse(result["report"]["secure"])

    def test_report_preserves_failed_checks_but_limits_and_redacts_errors(self):
        report = probe.summarize({"version": 1, "secure": False,
            "identity": {"secure": True, "checks": [{"name": "isolation", "status": "pass"}]},
            "workload": {"secure": False, "checks": [{"name": "filesystem", "status": "fail", "detail": "reason"}],
                         "error": "https://example.invalid/private?value=test " + "ghp_" + "a" * 40},
            "capture": {"secure": False, "error": "message " * 1000}, "private": "must disappear"})
        self.assertEqual(report["identity"]["checks"], [{"name": "isolation", "status": "pass"}])
        self.assertEqual(report["workload"]["checks"][0]["status"], "fail")
        self.assertLessEqual(len(report["capture"]["error"]), 2000)
        self.assertNotIn("ghp_", json.dumps(report))
        self.assertNotIn("https://", json.dumps(report))
        self.assertNotIn("private", report)

    def test_missing_report_keeps_exit_and_redacted_stderr_for_launch_detail(self):
        with mock.patch.object(probe, "capture", return_value={"stdout": "", "stderr": "TypeError: test\nKEY=private",
                "exitCode": 125}):
            result = probe.qualify("/test-runtime", "/test-home", True)
        self.assertIsNone(result["report"])
        self.assertEqual(result["exitCode"], 125)
        self.assertIn("TypeError", result["stderr"])
        self.assertNotIn("private", result["stderr"])

    def test_capture_bounds_output_and_clears_cwd_and_environment(self):
        result = probe.capture(["/usr/bin/python3", "-I", "-c", "import os; print(os.getcwd()); print(os.getenv('PRIVATE_VALUE','absent'))"],
                               {"PATH": "/usr/bin:/bin"}, 5)
        self.assertEqual(result["stdout"], "/\nabsent\n")
        self.assertEqual(result["exitCode"], 0)
        overflow = probe.capture(["/usr/bin/python3", "-I", "-c", "print('x'*100000)"], {}, 5, maximum=1000)
        self.assertTrue(overflow["outputLimit"])
        self.assertLessEqual(len(overflow["stdout"]), 1000)


if __name__ == "__main__":
    unittest.main()
