"""Real local process/socket checks; no live guest or native admission claim."""
import base64
import contextlib
import copy
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("verifier_bootstrap", HERE.parent / "bootstrap.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


@contextlib.contextmanager
def output():
    raw = io.BytesIO()
    wrapper = io.TextIOWrapper(raw, encoding="utf8")
    try:
        with mock.patch.object(b.sys, "stdout", wrapper):
            yield raw
    finally:
        wrapper.detach()


CLIENT = r'''
import json, os, socket, sys
s = socket.socket(fileno=int(os.environ['ZEROS_BUILD_VERIFY_FD']))
stream = s.makefile('rwb', buffering=0)
hello = json.loads(stream.readline(65537))
assert hello['schema'] == 'zeros.computer-build-verifier-session/v1'
assert hello['selection']['evidenceSha256'] == 'a' * 64
def packed(v): return json.dumps(v, sort_keys=True, separators=(',', ':')).encode()
request = {'selection': hello['selection'], 'runtime': {'fixture': True}}
ACTION
stream.close(); s.close()
sys.stdout.write('unchanged-setup-output')
'''


class FakeVerifier:
    def __init__(self):
        self.selection = {"mode": "build", "evidenceSha256": "a" * 64, "private": "synthetic-private-canary"}
        self.calls, self.finishes = [], 0

    def start(self, deadline, wall_deadline):
        self.deadline, self.wall_deadline = deadline, wall_deadline
        return {"schema": "zeros.computer-build-verifier-session/v1", "selection": self.selection,
                "deadlineMs": int(wall_deadline * 1000)}

    def verify(self, request):
        self.calls.append(copy.deepcopy(request))
        return {"schema": "zeros.computer-build-verification/v1", "fixture": True}

    def finish(self):
        self.finishes += 1


class Transport(unittest.TestCase):
    def run_client(self, action, verifier=None, timeout=2):
        verifier = verifier or FakeVerifier()
        with output() as stream:
            code, checks = b.run_setup([sys.executable, "-I", "-B", "-c", CLIENT.replace("ACTION", action)],
                                      "fixture-payload", timeout=timeout, build_verifier=verifier)
            self.assertEqual(stream.getvalue(), b"unchanged-setup-output\n")
        self.assertEqual((code, checks), (0, []))
        return verifier

    def assert_refused(self, action, verifier=None, timeout=2):
        with output() as stream:
            with self.assertRaises(b.Failure):
                b.run_setup([sys.executable, "-I", "-B", "-c", CLIENT.replace("ACTION", action)],
                            "fixture-payload", timeout=timeout, build_verifier=verifier or FakeVerifier())
            self.assertNotIn(b"synthetic-private-canary", stream.getvalue())

    def test_selected_transport_joins_exact_callback_and_preserves_setup_output(self):
        v = self.run_client("stream.write(packed(request) + b'\\n'); assert json.loads(stream.readline())['fixture']")
        self.assertEqual(len(v.calls), 1)
        self.assertEqual(v.calls[0]["selection"], v.selection)
        self.assertEqual(v.finishes, 1)

    def test_legacy_setup_has_no_channel_and_unchanged_output(self):
        with output() as stream:
            result = b.run_setup([sys.executable, "-I", "-B", "-c",
                "import os,sys; assert 'ZEROS_BUILD_VERIFY_FD' not in os.environ; assert sys.stdin.read()=='payload'; print('legacy')"], "payload")
            self.assertEqual(result, (0, []))
            self.assertEqual(stream.getvalue(), b"legacy\n")

    def test_missing_exchange_cannot_turn_a_support_offer_into_success(self):
        self.assert_refused("pass")

    def test_wrong_shape_duplicate_key_noncanonical_or_overflow_refuse(self):
        cases = [b'{"unexpected":true}\n', b'{"selection":0,"selection":1,"runtime":{}}\n',
                 b'{ "selection": 1, "runtime": {} }\n', b'x' * 65537]
        for raw in cases:
            with self.subTest(size=len(raw)):
                self.assert_refused("stream.write(" + repr(raw) + "); stream.readline()")

    def test_more_than_eight_requests_cannot_restart_session_budget(self):
        self.assert_refused("for _ in range(9):\n    stream.write(packed(request) + b'\\n'); stream.readline()")

    def test_partial_request_and_late_output_refuse(self):
        self.assert_refused("stream.write(b'{'); import time; time.sleep(5)", timeout=0.1)

    def test_deadline_keeps_the_existing_timeout_code_and_timed_out_bit(self):
        with output(), self.assertRaises(b.Failure) as caught:
            b.run_setup([sys.executable, "-I", "-B", "-c", "import time; time.sleep(5)"], "payload", timeout=0.03)
        self.assertEqual(caught.exception.code, 124)
        self.assertTrue(caught.exception.timed_out)

    def test_canonical_unicode_selection_is_not_escaped_or_rejected(self):
        v = FakeVerifier()
        v.selection["billingOrg"] = "組織-é"
        action = "stream.write(json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode() + b'\\n'); assert json.loads(stream.readline())['fixture']"
        self.run_client(action, v)

    def test_callback_crossing_original_deadline_never_replies(self):
        v = FakeVerifier()
        original = v.verify
        def slow(request):
            time.sleep(0.12)
            return original(request)
        v.verify = slow
        self.assert_refused("stream.write(packed(request) + b'\\n'); stream.readline()", v, timeout=0.08)
        self.assertEqual(v.finishes, 0)

    def test_failure_and_cancel_unwind_descriptors(self):
        initial = set(os.listdir('/proc/self/fd'))
        for failure in (b.Failure("base_compatibility"), b.Failure("process_signal", code=143)):
            v = FakeVerifier()
            v.verify = mock.Mock(side_effect=failure)
            self.assert_refused("stream.write(packed(request) + b'\\n'); stream.readline()", v)
            self.assertEqual(initial, set(os.listdir('/proc/self/fd')))

    def test_outer_signal_interrupts_preparation_without_spawning_or_leaking(self):
        initial = set(os.listdir('/proc/self/fd'))
        v = FakeVerifier()
        v.start = mock.Mock(side_effect=b.Failure("process_signal", code=143))
        with mock.patch.object(b.subprocess, "Popen") as spawn:
            self.assert_refused("pass", v)
            spawn.assert_not_called()
        self.assertEqual(initial, set(os.listdir('/proc/self/fd')))

    def test_real_signals_during_spawn_verify_and_retirement_preserve_cleanup(self):
        for phase in ("spawn", "verify", "retirement"):
            with self.subTest(phase=phase):
                before = set(os.listdir('/proc/self/fd'))
                saved = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
                children, sent = [], []
                def interrupted(signum, _frame):
                    raise b.Failure("process_signal", code=128 + signum)
                for sig in saved: signal.signal(sig, interrupted)
                original_spawn = b.subprocess.Popen
                def spawn(*args, **kwargs):
                    child = original_spawn(*args, **kwargs)
                    original_wait = child.wait
                    children.append((child, original_wait))
                    waits = []
                    def wait(*args, **kwargs):
                        waits.append(True)
                        if (phase == "verify" or phase == "retirement" and len(waits) == 2) and not sent:
                            sent.append(True)
                            os.kill(os.getpid(), signal.SIGINT if phase == "verify" else signal.SIGTERM)
                            os.kill(os.getpid(), signal.SIGINT)
                        return original_wait(*args, **kwargs)
                    child.wait = wait
                    if phase == "spawn": os.kill(os.getpid(), signal.SIGTERM)
                    return child
                verifier = FakeVerifier()
                if phase == "verify":
                    def cancelled(_request): os.kill(os.getpid(), signal.SIGTERM)
                    verifier.verify = cancelled
                try:
                    with mock.patch.object(b.subprocess, "Popen", side_effect=spawn), output() as stream:
                        with self.assertRaises(b.Failure) as caught:
                            b.run_setup([sys.executable, "-I", "-B", "-c", CLIENT.replace("ACTION",
                                "stream.write(packed(request) + b'\\n'); stream.readline()")],
                                "fixture-payload", timeout=2, build_verifier=verifier)
                        self.assertEqual(caught.exception.code, 143, "repeated cancellation replaced the first outcome")
                        self.assertEqual(stream.getvalue(), b"", "cancelled setup published success before retirement")
                    self.assertEqual(len(children), 1)
                    child, _wait = children[0]
                    self.assertIsNotNone(child.returncode, "the original child was not joined")
                    self.assertTrue(child.stdin.closed and child.stdout.closed, "original child descriptors escaped")
                    self.assertEqual(before, set(os.listdir('/proc/self/fd')))
                    for sig in saved: self.assertIs(signal.getsignal(sig), interrupted)
                finally:
                    # Keep the intentionally failing parent replay disposable.
                    for sig, handler in saved.items(): signal.signal(sig, handler)
                    for child, wait in children:
                        try: os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                        wait(timeout=2)
                        child.stdin.close(); child.stdout.close()


class InstallerLock(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        (self.root / "run/zeros").mkdir(parents=True, mode=0o700)
        self.app = b.Bootstrap(self.root, uid=os.getuid(), gid=os.getgid())
        self.file = self.root / "run/zeros/runtime-install.lock"

    def test_original_held_flock_is_rechecked_without_acquiring_another_lock(self):
        with mock.patch.object(b.fcntl, "flock", wraps=fcntl.flock) as calls:
            with self.app.lock("runtime-install.lock") as current:
                self.assertTrue(callable(current), "selected setup needs the original lock witness")
                current(); current()
                self.assertEqual(calls.call_count, 1)
                with self.assertRaises(b.Failure):
                    with self.app.lock("runtime-install.lock"): pass

    def test_replaced_named_lock_and_directory_refuse_and_keep_original_locked(self):
        for changed in ("file", "directory"):
            with self.subTest(changed=changed):
                with self.app.lock("runtime-install.lock") as current:
                    self.assertTrue(callable(current))
                    if changed == "file":
                        old = self.file.with_name("original.lock")
                        self.file.rename(old); self.file.touch(mode=0o600)
                    else:
                        old_dir = self.file.parent.with_name("original")
                        self.file.parent.rename(old_dir)
                        self.file.parent.mkdir(mode=0o700); self.file.touch(mode=0o600)
                        old = old_dir / self.file.name
                    with self.assertRaises(b.Failure): current()
                    with old.open("r+") as held:
                        with self.assertRaises(BlockingIOError): fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with old.open("r+") as retired: fcntl.flock(retired, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(self.file.read_bytes(), b"")

    def test_unlocked_original_descriptor_cannot_claim_current_custody(self):
        original = fcntl.flock
        descriptors = []
        def remember(fd, operation):
            descriptors.append(fd); return original(fd, operation)
        before = set(os.listdir('/proc/self/fd'))
        with mock.patch.object(b.fcntl, "flock", side_effect=remember):
            with self.app.lock("runtime-install.lock") as current:
                self.assertTrue(callable(current))
                current()
                original(descriptors[0], fcntl.LOCK_UN)
                with self.assertRaises(b.Failure): current()
        self.assertEqual(before, set(os.listdir('/proc/self/fd')))


if __name__ == '__main__': unittest.main()
