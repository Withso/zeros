"""Final acceptance after real child/socket retirement under the original flock.

Guest/kernel probes use the producer fixture; the session, transport, immutable
record files and installation-lock witness are production code. No live guest.
"""
import json
import os
from pathlib import Path
import signal
import sys
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_build_verifier_transport as transport
import test_computer_build_qualification as fixtures

b = transport.b
q = fixtures.qualification


class Retirement(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.Producer("test_complete_fixed_probe_records_exact_original_scope_after_full_byte_checks")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.session, _selection = self.fixture.boot_session()
        self.monotonic, self.now = time.monotonic, time.time
        self.offsets = [0, 0]
        self.session.monotonic = lambda: self.monotonic() + self.offsets[0]
        self.session.now = lambda: self.now() + self.offsets[1]
        runtime = {key: self.fixture.active[key] for key in q.RUNTIME_FIELDS}
        self.client = (
            "import json,os,socket,sys\n"
            "s=socket.socket(fileno=int(os.environ['ZEROS_BUILD_VERIFY_FD']))\n"
            "f=s.makefile('rwb',buffering=0)\n"
            "hello=json.loads(f.readline(65537))\n"
            "request={'selection':hello['selection'],'runtime':json.loads(" + repr(json.dumps(runtime)) + ")}\n"
            "f.write(json.dumps(request,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()+b'\\n')\n"
            "assert json.loads(f.readline(16385))['schema']=='zeros.computer-build-verification/v1'\n"
            "f.close();s.close();sys.stdout.write('synthetic-ready')\n"
        )
        (self.fixture.root / "run/zeros").mkdir(parents=True, mode=0o700)
        self.lock_app = b.Bootstrap(self.fixture.root, uid=os.getuid(), gid=os.getgid())
        self.lock_file = self.fixture.root / "run/zeros/runtime-install.lock"

    def mutate(self, kind):
        if kind in ("lock", "lock_and_signals"):
            self.lock_file.rename(self.lock_file.with_name("original-owned.lock"))
            self.lock_file.touch(mode=0o600)
        elif kind == "runtime":
            self.fixture.active["supervisorSessionId"] = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        elif kind == "record":
            path = self.fixture.directory / "integrity.json"
            raw = path.read_bytes()
            path.rename(path.with_name("original-integrity.json"))
            path.write_bytes(raw)
            path.chmod(0o444)
        elif kind == "monotonic":
            self.offsets[0] += 10
        elif kind == "wall":
            self.offsets[1] += 10
        else:
            self.assertEqual(kind, "signals")
        if kind in ("signals", "lock_and_signals"):
            # At final verification the first signal raises immediately. The
            # second must still run without replacing that original exception.
            try: os.kill(os.getpid(), signal.SIGTERM)
            finally: os.kill(os.getpid(), signal.SIGINT)

    def execute(self, *, kind=None, phase="join", first_failure=None):
        changed, children, events = [], [], []
        before = set(os.listdir("/proc/self/fd"))
        saved = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)}
        original_spawn, original_pair = b.subprocess.Popen, b.socket.socketpair
        original_finish, original_verify = self.session.finish, self.session.verify

        def change(at):
            if kind and phase == at:
                self.assertFalse(changed, "the intended retirement window must run exactly once")
                changed.append(at)
                self.mutate(kind)

        def finish():
            events.append("finish")
            change("finish")
            return original_finish()

        def verify(request):
            if first_failure is not None: raise first_failure
            return original_verify(request)

        def spawn(*args, **kwargs):
            child = original_spawn(*args, **kwargs)
            original_wait = child.wait
            children.append((child, original_wait))
            waits = []

            def wait(*args, **kwargs):
                waits.append(True)
                # Success first joins inside the transport, then retires its
                # group in finally. An exchange failure enters finally first.
                retirement = len(waits) == (1 if first_failure is not None else 2)
                if retirement: change("join")
                result = original_wait(*args, **kwargs)
                if retirement: events.append("child_joined")
                return result

            child.wait = wait
            return child

        class Channel:
            def __init__(self, socket): self.socket = socket
            def __getattr__(self, name): return getattr(self.socket, name)
            def close(self):
                self.socket.close()
                events.append("channel_closed")
                change("channel")

        def socketpair(*args, **kwargs):
            channel, client = original_pair(*args, **kwargs)
            return Channel(channel), client

        try:
            with self.lock_app.lock("runtime-install.lock") as current:
                self.session.assert_current = current
                current()
                with mock.patch.object(b.subprocess, "Popen", side_effect=spawn), \
                     mock.patch.object(b.socket, "socketpair", side_effect=socketpair), \
                     mock.patch.object(b.time, "monotonic", side_effect=self.session.monotonic), \
                     mock.patch.object(b.time, "time", side_effect=self.session.now), \
                     mock.patch.object(self.session, "finish", side_effect=finish), \
                     mock.patch.object(self.session, "verify", side_effect=verify), transport.output() as output:
                    failure = None
                    try:
                        result = b.run_setup([sys.executable, "-I", "-B", "-c", self.client], "synthetic-payload", timeout=3,
                                             build_verifier=b.InstallerBuildVerifier(q, self.session))
                    except (b.Failure, q.Failure) as error:
                        result, failure = None, error
                    published = output.getvalue()
                if kind in ("lock", "lock_and_signals") and changed:
                    with self.assertRaises(b.Failure): current()
            self.assertEqual(len(children), 1)
            child, _ = children[0]
            self.assertIsNotNone(child.returncode)
            self.assertTrue(child.stdin.closed and child.stdout.closed)
            self.assertEqual(set(os.listdir("/proc/self/fd")), before)
            for sig, handler in saved.items(): self.assertIs(signal.getsignal(sig), handler)
            if kind: self.assertEqual(changed, [phase], "the intended I/O window must actually run")
            return result, failure, published, events
        finally:
            for child, wait in children:
                if child.returncode is None:
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    wait(timeout=2)
                child.stdin.close()
                child.stdout.close()

    def assert_refused(self, kind, phase="join"):
        result, failure, output, events = self.execute(kind=kind, phase=phase)
        self.assertIsNone(result, "selected success escaped a change during retirement")
        self.assertIsNotNone(failure)
        self.assertEqual(output, b"")
        return failure, events

    def test_unchanged_retirement_accepts_only_after_child_and_channel_close(self):
        result, failure, output, events = self.execute()
        self.assertIsNone(failure)
        self.assertEqual(result, (0, []))
        self.assertEqual(output, b"synthetic-ready\n")
        self.assertEqual(events, ["child_joined", "channel_closed", "finish"])
        self.assertEqual(self.session._state, "finished")

    def test_lock_replacement_during_retirement_refuses(self): self.assert_refused("lock")
    def test_runtime_replacement_during_retirement_refuses(self): self.assert_refused("runtime")
    def test_record_replacement_during_retirement_refuses(self): self.assert_refused("record")
    def test_lock_replacement_at_channel_close_refuses(self): self.assert_refused("lock", "channel")
    def test_runtime_replacement_at_channel_close_refuses(self): self.assert_refused("runtime", "channel")
    def test_record_replacement_at_channel_close_refuses(self): self.assert_refused("record", "channel")

    def test_original_monotonic_deadline_still_bounds_retirement(self):
        failure, _events = self.assert_refused("monotonic")
        self.assertEqual(failure.code, 124)
        self.assertTrue(failure.timed_out)

    def test_original_wall_deadline_still_bounds_retirement(self):
        failure, _events = self.assert_refused("wall", "channel")
        self.assertEqual(failure.code, 124)
        self.assertTrue(failure.timed_out)

    def test_pending_retirement_signals_refuse_before_final_verification(self):
        failure, events = self.assert_refused("signals")
        self.assertEqual(failure.code, 143)
        self.assertNotIn("finish", events)

    def test_pending_channel_signals_refuse_before_final_verification(self):
        failure, events = self.assert_refused("signals", "channel")
        self.assertEqual(failure.code, 143)
        self.assertNotIn("finish", events)

    def test_final_verification_remains_signal_guarded_after_all_retirement_io(self):
        failure, events = self.assert_refused("signals", "finish")
        self.assertEqual(failure.code, 143)
        self.assertEqual(events, ["child_joined", "channel_closed", "finish"])

    def test_first_exchange_failure_wins_over_late_changed_custody_and_signals(self):
        first = b.Failure("base_compatibility")
        result, failure, output, events = self.execute(kind="lock_and_signals", first_failure=first)
        self.assertIsNone(result)
        self.assertIs(failure, first)
        self.assertEqual(output, b"")
        self.assertEqual(events, ["child_joined", "channel_closed"])


if __name__ == "__main__": unittest.main(verbosity=2)
