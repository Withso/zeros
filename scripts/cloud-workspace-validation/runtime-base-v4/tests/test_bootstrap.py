"""Rootless security and interruption tests for the base-owned verifier.

The temporary root and host adapter are Python-only injection points, never CLI
options or environment variables accepted by the shipped root entry point.
"""
import base64
import copy
import contextlib
import datetime
import errno
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import stat
import sys
import tarfile
import tempfile
import unittest
import types
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SHARED_FIXTURES = HERE.parents[3] / "packages/protocol/src/__tests__/fixtures/cloud-runtime"


def golden_directory(repo_root=HERE.parents[3]):
    shared = repo_root / "packages/protocol/src/__tests__/fixtures/cloud-runtime"
    return shared if shared.is_dir() else HERE / "fixtures/cloud-runtime"


GOLDEN = golden_directory()
SPEC = importlib.util.spec_from_file_location("bootstrap", HERE.parent / "bootstrap.py")
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)
NOW = datetime.datetime(2026, 10, 4, tzinfo=datetime.timezone.utc)
BOOT = "12345678-1234-4234-8234-123456789abc"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fixture(extra=None, change=None, transform=None):
    """Synthetic bytes with the shared B1 manifest header."""
    contents = {
        "bin/node": b"synthetic node\n", "bin/start-engine.sh": b"synthetic engine\n",
        "lib/zeros/cloud-worker-supervisor.mjs": b"synthetic supervisor\n",
        "lib/zeros/setup-cloud-workspace.mjs": b"synthetic setup\n",
        "lib/zeros/runtime-self-test.mjs": b"synthetic self test\n",
        "worker/dist-engine/cli.js": b"synthetic cli\n",
        "worker/data.txt": b"synthetic data\n",
    }
    contents.update(extra or {})
    entries = {p: {"path": p, "type": "file", "mode": "0555", "size": len(v), "sha256": digest(v)} for p, v in contents.items()}
    for p in list(entries):
        for parent in Path(p).parents:
            if str(parent) != ".":
                entries[str(parent)] = {"path": str(parent), "type": "dir", "mode": "0755"}
    manifest = json.loads((GOLDEN / "manifest.valid.json").read_text())
    manifest["files"] = sorted(entries.values(), key=lambda x: x["path"].encode())
    if change:
        change(manifest)
    raw = canonical(manifest)
    archive = io.BytesIO()
    with gzip.GzipFile(fileobj=archive, mode="wb", mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
            first = tarfile.TarInfo("manifest.json")
            first.mode, first.size = 0o444, len(raw)
            tar.addfile(first, io.BytesIO(raw))
            for entry in manifest["files"]:
                info = tarfile.TarInfo(entry["path"])
                if entry["type"] == "dir":
                    info.type, info.mode = tarfile.DIRTYPE, int(entry["mode"], 8)
                elif entry["type"] == "symlink":
                    info.type, info.mode, info.linkname = tarfile.SYMTYPE, 0o555, entry["target"]
                else:
                    info.mode, info.size = int(entry["mode"], 8), len(contents[entry["path"]])
                if transform:
                    transform(info)
                tar.addfile(info, io.BytesIO(contents.get(entry["path"], b"")))
    payload = archive.getvalue()
    desc = {"runtimeId": "r1-" + digest(raw), "manifestSha256": digest(raw),
            "archiveSha256": digest(payload), "archiveBytes": len(payload),
            "expandedBytes": sum(e.get("size", 0) for e in manifest["files"]),
            "sourceCommit": manifest["source"]["commit"], "nodeModulesAbi": 127,
            "bootstrapProtocolVersion": 1, "engineProtocolVersion": 20}
    value = {"schema": "zeros.runtime-install/v1", "purpose": "build", "runtime": desc,
             "artifact": {"url": "https://fixture.r2.cloudflarestorage.com/runtime-test/test?signature=private-canary",
                          "expiresAt": "2026-10-04T00:10:00Z"}}
    return payload, value, manifest


def encoded(value):
    return base64.urlsafe_b64encode(canonical(value)).rstrip(b"=")


@contextlib.contextmanager
def binary_stdout():
    output = io.BytesIO()
    wrapper = io.TextIOWrapper(output, encoding="utf-8")
    try:
        with mock.patch.object(b.sys, "stdout", wrapper):
            yield output
            wrapper.flush()
    finally:
        wrapper.detach()


@contextlib.contextmanager
def no_directory_renames():
    """Boat preserves file renames but loses renamed directories' children."""
    def checked(operation):
        def rename(source, destination, **kwargs):
            info = os.stat(source, dir_fd=kwargs.get("src_dir_fd"), follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                raise AssertionError("runtime publication renamed a directory")
            return operation(source, destination, **kwargs)
        return rename
    with mock.patch.object(b.os, "rename", side_effect=checked(os.rename)), \
            mock.patch.object(b.os, "replace", side_effect=checked(os.replace)):
        yield


def template(name):
    path = HERE.parent.parent / "boat-image/templates/v4" / name
    spec = importlib.util.spec_from_file_location("base_template", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def units(boot="active", boot_sub="exited", host="active", host_sub="running", result="success", code=0):
    return (f"Id=zeros-boot.service\nActiveState={boot}\nSubState={boot_sub}\nResult={result}\nExecMainStatus={code}\n\n"
            f"Id=zeros-host.service\nActiveState={host}\nSubState={host_sub}\nResult=success\nExecMainStatus=0\n").encode()


def cgroup_fixture(root):
    scope = root / "sys/fs/cgroup/system.slice/zeros-host.service"
    (scope / "host").mkdir(parents=True)
    for name, value in (("cgroup.procs", ""), ("cgroup.subtree_control", "cpu memory pids"),
                        ("host/cpu.max", "100000 100000"), ("host/memory.max", "536870912"),
                        ("host/pids.max", "256"), ("host/memory.oom.group", "1")):
        (scope / name).write_text(value + "\n")
    return scope


class FakeMounts:
    """Mount-namespace model for rootless bootstrap lifecycle tests."""
    def __init__(self):
        self.links = {}
        self.calls = []
        self.fail = None

    def present(self, target):
        return str(target) in self.links

    def unmounted(self, target):
        b.require(not any(path == str(target) or path.startswith(str(target) + "/") for path in self.links), "base_compatibility")

    mount_id = b.BindMounts.mount_id
    table = b.BindMounts.table

    def bind(self, source_fd, target_fd):
        source = os.readlink(f"/proc/self/fd/{source_fd}")
        target = os.readlink(f"/proc/self/fd/{target_fd}")
        if target == self.fail:
            raise b.Failure("base_compatibility")
        self.calls.append((source, target))
        self.links[target] = source

    def verify(self, source, target, source_fd, _target_fd):
        b.require(self.links.get(str(target)) == str(source), "base_compatibility")
        st = os.fstat(source_fd)
        return {"device": st.st_dev, "inode": st.st_ino}


class FakeHost:
    def __init__(self):
        self.calls = []
        self.state = "active"
        self.setup_code = 0
        self.setup_checks = []
        self.runtime = None

    def load_apparmor(self):
        pass

    def cgroup(self):
        return b.CGROUP

    def stop(self):
        self.calls.append("stop")
        self.state = "inactive"

    def start(self, app, runtime_id):
        self.calls.append("start")
        self.state = "active"
        app.activate(runtime_id, "/sys/fs/cgroup/system.slice/zeros-host.service")

    def status(self):
        return self.state

    def setup(self, root, payload):
        self.calls.append(("setup", root, payload))
        return self.setup_code, self.setup_checks


class Crash(BaseException):
    pass


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.host = FakeHost()
        self.payload, self.value, self.manifest = fixture()
        self.downloads = 0
        self.app = b.Bootstrap(self.root, uid=os.getuid(), gid=os.getgid(), host=self.host,
                               now=lambda: NOW, boot_id=lambda: BOOT, downloader=self.download)
        self.mounts = FakeMounts()
        self.app.mounts = self.mounts
        self.app.accounts = {name: (os.getuid(), os.getgid()) for name in ("user", "agent", "capture", "engine")}
        bootstrap = self.root / "opt/zeros-bootstrap"
        bootstrap.mkdir(parents=True)
        compat = json.loads((HERE.parent / "compatibility.json").read_text())
        (bootstrap / "protected").write_bytes(b"base-owned")
        (bootstrap / "protected").chmod(0o555)
        profile = self.root / "etc/apparmor.d/zeros-cloud-engine"
        profile.parent.mkdir(parents=True)
        profile.write_bytes((HERE.parent / "zeros-cloud-engine.apparmor").read_bytes())
        profile.chmod(0o444)
        compat["protectedFiles"] = [{"path": "/opt/zeros-bootstrap/protected", "mode": "0555", "sha256": digest(b"base-owned")},
                                    {"path": "/etc/apparmor.d/zeros-cloud-engine", "mode": "0444", "sha256": digest(profile.read_bytes())}]
        (bootstrap / "compatibility.json").write_bytes(canonical(compat))
        (bootstrap / "compatibility.json").chmod(0o444)
        self.app.boot()

    def tearDown(self):
        self.temp.cleanup()

    def download(self, artifact, stream, descriptor):
        self.downloads += 1
        stream.write(self.payload)

    def install(self):
        return self.app.install(encoded(self.value))

    def runtime(self, value=None):
        return self.root / "opt/zeros-infra" / (value or self.value)["runtime"]["runtimeId"]

    def reject(self, check):
        with self.assertRaises(b.Failure) as caught:
            self.install()
        self.assertIn(check, caught.exception.checks)
        self.assertNotIn("start", self.host.calls)
        self.assertFalse((self.root / "opt/zeros/current").exists())

    def test_empty_boot_status_and_facade(self):
        self.assertEqual(os.readlink(self.root / "zeros"), "/opt/zeros")
        self.assertEqual(self.app.status()["hostState"], "waiting_for_runtime")
        self.assertIsNone(self.app.status()["currentRuntimeId"])
        self.assertEqual((self.root / "opt/zeros/disk-epoch").read_text(), "1\n")
        self.app.boot()
        self.assertEqual((self.root / "opt/zeros/disk-epoch").read_text(), "1\n")

    def test_restore_without_early_boot_reloads_apparmor_and_recreates_tmpfiles(self):
        self.install()
        previous = self.app.current()
        (self.root / "zeros").unlink()
        shutil.rmtree(self.root / "run/zeros")
        self.app.host = b.SystemHost()
        self.app.boot_id = lambda: "22222222-2222-4222-8222-222222222222"
        loaded = False

        def load(command, **kwargs):
            nonlocal loaded
            self.assertEqual(command, ["/usr/sbin/apparmor_parser", "-r", "-W", "/etc/apparmor.d/zeros-cloud-engine"])
            self.assertEqual(kwargs, {"env": b.ENV, "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                                      "stderr": subprocess.DEVNULL, "timeout": 30, "check": False})
            self.assertEqual(os.readlink(self.root / "zeros"), "/opt/zeros")
            self.assertEqual((self.root / "run/zeros").stat().st_mode & 0o777, 0o700)
            loaded = True
            return mock.Mock(returncode=0)

        with mock.patch.object(b.subprocess, "run", side_effect=load) as command:
            self.app.boot()
            self.assertTrue(loaded, "restore left the base AppArmor policy unloaded")
            self.assertEqual((self.root / "run/zeros/boot-id").read_text(), self.app.boot_id())
            self.assertEqual(self.app.current(), previous)
            self.app.verify_runtime(previous)
            epoch = self.app.epoch()
            loaded = False
            self.app.boot()
            self.assertTrue(loaded, "boot must reload policy even when its kernel boot ID is unchanged")
            self.assertEqual(command.call_count, 2)
            self.assertEqual(self.app.epoch(), epoch)

    def test_boot_verifies_the_protected_apparmor_profile_before_loading(self):
        profile = self.root / "etc/apparmor.d/zeros-cloud-engine"
        profile.chmod(0o644)
        profile.write_bytes(b"unverified profile")
        profile.chmod(0o444)
        self.app.host = b.SystemHost()
        with mock.patch.object(b.subprocess, "run") as command:
            with self.assertRaises(b.Failure) as caught:
                self.app.boot()
            self.assertEqual(caught.exception.checks, ["base_compatibility"])
            command.assert_not_called()

    def test_boot_apparmor_failures_are_closed_and_do_not_publish_readiness(self):
        self.app.host = b.SystemHost()
        ready = self.root / "run/zeros/boot-id"
        ready.unlink()
        outcomes = (({"return_value": mock.Mock(returncode=1, stdout=b"private-canary", stderr=b"private-canary")}, 1, False),
                    ({"side_effect": FileNotFoundError("private-canary")}, 1, False),
                    ({"side_effect": PermissionError("private-canary")}, 1, False),
                    ({"side_effect": subprocess.TimeoutExpired("private-canary", 30)}, 124, True))
        for outcome, expected_code, timed_out in outcomes:
            with self.subTest(outcome=expected_code, error=type(outcome.get("side_effect")).__name__), \
                 mock.patch.object(b.subprocess, "run", **outcome) as command:
                code, output = self.cli(["boot"])
                self.assertEqual(code, expected_code)
                self.assertEqual(json.loads(output), {"schema": "zeros.diagnostic/v1", "component": "bootstrap",
                    "stage": "validate_input", "ok": False, "exitCode": expected_code, "timedOut": timed_out,
                    "failedChecks": ["apparmor"]})
                self.assertNotIn(b"private-canary", output)
                self.assertFalse(ready.exists())
                command.assert_called_once()

    def test_base_probe_waits_for_completed_boot_before_reading_metadata_or_facade(self):
        verifier = template("verify.py")
        scope = cgroup_fixture(self.root)
        (self.root / "zeros").unlink()
        self.app.host = b.SystemHost()
        replies = [units(boot="activating", boot_sub="start", host="inactive", host_sub="dead"),
                   units(host="activating", host_sub="start"), units()]
        calls = []
        loaded = False
        original_read = self.app.read

        class MetadataReached(Exception):
            pass

        def probe(command, **_kwargs):
            nonlocal loaded
            if command == ["/usr/sbin/apparmor_parser", "-r", "-W", "/etc/apparmor.d/zeros-cloud-engine"]:
                loaded = True
                return mock.Mock(returncode=0)
            calls.append(command)
            return mock.Mock(returncode=0, stdout=replies.pop(0))

        def boot_finishes(_seconds):
            self.app.boot()

        def read(absolute, limit, mode=None):
            if absolute == "/etc/zeros/cloud-worker.json":
                self.assertEqual(len(calls), 3, "verification read the base before both units completed startup")
                self.assertTrue(loaded, "verification reached the profile check before boot loaded it")
                self.assertEqual(os.readlink(self.root / "zeros"), "/opt/zeros")
                raise MetadataReached()
            return original_read(absolute, limit, mode)

        injected = types.SimpleNamespace(Bootstrap=lambda: self.app, require=b.require, ENV=b.ENV, CGROUP=b.CGROUP)
        with mock.patch.object(verifier.importlib.util, "spec_from_file_location", return_value=mock.Mock()), \
             mock.patch.object(verifier.importlib.util, "module_from_spec", return_value=injected), \
             mock.patch.object(b, "CGROUP", str(scope)), \
             mock.patch.object(b.subprocess, "run", side_effect=probe), \
             mock.patch.object(b.time, "sleep", side_effect=boot_finishes), \
             mock.patch.object(self.app, "read", side_effect=read):
            with self.assertRaises(MetadataReached):
                verifier.verify()

    def test_active_host_readiness_waits_for_dispatch_cgroup_initialization(self):
        self.app.host = b.SystemHost()
        scope = cgroup_fixture(self.root)
        pending = (("cgroup.procs", "123"), ("cgroup.subtree_control", "cpu"),
                   ("host/cpu.max", "max 100000"), ("host/memory.max", "max"),
                   ("host/pids.max", "max"), ("host/memory.oom.group", "0"), ("host/pids.max", None))
        for name, value in pending:
            with self.subTest(predicate=name, initial=value):
                target = scope / name
                ready = target.read_text()
                if value is None:
                    target.unlink()
                else:
                    target.write_text(value + "\n")
                with mock.patch.object(b, "CGROUP", str(scope)), \
                     mock.patch.object(b.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=units())) as command, \
                     mock.patch.object(b.time, "sleep", side_effect=lambda _seconds: target.write_text(ready)) as wait:
                    self.app.wait_ready()
                    wait.assert_called_once_with(0.2)
                    self.assertEqual(command.call_count, 2, "active units are not sufficient before dispatch writes its limits")

    def test_active_host_that_never_initializes_times_out_before_metadata_is_read(self):
        self.app.host = b.SystemHost()
        scope = cgroup_fixture(self.root)
        (scope / "host/memory.max").write_text("max\n")
        with mock.patch.object(b, "CGROUP", str(scope)), \
             mock.patch.object(b.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=units())), \
             mock.patch.object(b.time, "sleep"), mock.patch.object(b.time, "monotonic", side_effect=[0, 0, 600]), \
             mock.patch.object(self.app, "read", wraps=self.app.read) as read:
            with self.assertRaises(b.Failure) as caught:
                self.app.wait_ready()
            self.assertEqual(caught.exception.checks, ["timeout"])
            self.assertEqual(caught.exception.code, 124)
            self.assertTrue(caught.exception.timed_out)
            read.assert_not_called()

    def test_readiness_allows_boot_hydration_beyond_normal_host_start_grace(self):
        self.app.host = b.SystemHost()
        with mock.patch.object(b.subprocess, "run", side_effect=[
                mock.Mock(returncode=0, stdout=units(boot="activating", boot_sub="start", host="inactive", host_sub="dead")),
                mock.Mock(returncode=0, stdout=units())]) as command, \
             mock.patch.object(self.app.host, "cgroup_ready", return_value=True), \
             mock.patch.object(b.time, "sleep"), mock.patch.object(b.time, "monotonic", side_effect=[0, 0, 35]):
            self.app.wait_ready()
        self.assertEqual(command.call_count, 2)

    def test_base_readiness_rejects_failed_boot_and_malformed_facade(self):
        self.app.host = b.SystemHost()
        scope = cgroup_fixture(self.root)
        with mock.patch.object(b.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=units(boot="failed", result="exit-code", code=1))) as command:
            with self.assertRaises(b.Failure) as caught:
                self.app.wait_ready()
            self.assertEqual(caught.exception.checks, ["host_start"])
            self.assertEqual(command.call_count, 1)
        (self.root / "zeros").unlink()
        (self.root / "zeros").symlink_to("/unexpected")
        with mock.patch.object(b, "CGROUP", str(scope)), \
             mock.patch.object(b.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=units())):
            with self.assertRaises(b.Failure) as caught:
                self.app.wait_ready()
            self.assertEqual(caught.exception.checks, ["pointer_publish"])
        self.assertEqual(os.readlink(self.root / "zeros"), "/unexpected")

    def test_protected_path_ancestry_checks_cover_each_path(self):
        verifier = template("verify.py")
        other = self.root / "usr/local/share/zeros"
        other.mkdir(parents=True)
        self.app.compat["protectedFiles"].append({"path": "/usr/local/share/zeros/protected", "mode": "0444", "sha256": "1" * 64})
        verifier.verify_protected_ancestry(self.app)
        (self.root / "usr/local").chmod(0o775)
        with self.assertRaises(b.Failure) as caught:
            verifier.verify_protected_ancestry(self.app)
        self.assertEqual(caught.exception.checks, ["file_mode"])
        (self.root / "usr/local").chmod(0o755)
        original = b.os.fstat

        def user_owned_opt(fd):
            value = original(fd)
            if os.readlink(f"/proc/self/fd/{fd}") == str(self.root / "opt"):
                fields = list(value)
                fields[4] += 1
                return os.stat_result(fields)
            return value

        with mock.patch.object(b.os, "fstat", side_effect=user_owned_opt):
            with self.assertRaises(b.Failure) as caught:
                verifier.verify_protected_ancestry(self.app)
        self.assertEqual(caught.exception.checks, ["root_ownership"])

    def test_private_failure_log_distinguishes_assertions_without_changing_stdout(self):
        link = self.root / "zeros"
        link.unlink()
        link.mkdir()
        failures = []
        for malformed in (True, False):
            if not malformed:
                link.rmdir()
                link.symlink_to("/private-canary")
            try:
                self.app.link("/zeros", "/opt/zeros")
            except b.Failure as error:
                failures.append(error)
                self.assertTrue(self.app.log_failure(error))
        log = self.root / "run/zeros/bootstrap-failures.jsonl"
        entries = [json.loads(line) for line in log.read_bytes().splitlines()]
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["failedChecks"], ["pointer_publish"])
        self.assertEqual(entries[1]["failedChecks"], ["pointer_publish"])
        self.assertNotEqual(entries[0]["sites"], entries[1]["sites"])
        self.assertTrue(all(site["line"] > 0 for entry in entries for site in entry["sites"]))
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(b"private-canary", log.read_bytes())
        self.assertNotIn(str(self.root).encode(), log.read_bytes())
        with mock.patch.object(b.sys, "stdout", io.StringIO()) as output:
            b.diagnostic("bootstrap", "validate_input", 1, failures[0])
        self.assertNotIn("sites", json.loads(output.getvalue()))
        line = log.read_bytes().splitlines(keepends=True)[0]
        log.write_bytes(line * (65536 // len(line)))
        self.assertTrue(self.app.log_failure(failures[1]))
        self.assertLessEqual(log.stat().st_size, 65536)
        for line in log.read_bytes().splitlines():
            json.loads(line)

    def test_private_oserror_evidence_retains_errno_and_original_bootstrap_site(self):
        self.install()
        with mock.patch.object(b.os, "listxattr", side_effect=OSError(errno.EIO, "private-canary", "/private-canary")):
            code, output = self.cli(["dispatch"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output), {"schema": "zeros.diagnostic/v1", "component": "bootstrap",
            "stage": "verify_tree", "ok": False, "exitCode": 1, "timedOut": False, "failedChecks": ["file_inventory"]})
        log = self.root / "run/zeros/bootstrap-failures.jsonl"
        evidence = json.loads(log.read_bytes().splitlines()[-1])
        self.assertEqual(evidence["error"], "OSError")
        self.assertEqual(evidence["errno"], {"name": "EIO", "number": errno.EIO})
        self.assertEqual(evidence["failedChecks"], ["file_inventory"])
        self.assertEqual(evidence["sites"][0]["function"], "verify_tree")
        self.assertEqual(evidence["sites"][0]["source"], "bootstrap")
        self.assertGreater(evidence["sites"][0]["line"], 0)
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(b"private-canary", log.read_bytes() + output)

    def assert_fresh_dispatch(self, runtime_id, boot=False):
        boot_id = "22222222-2222-4222-8222-222222222222" if boot else self.app.boot_id()
        dispatcher = b.Bootstrap(self.root, uid=os.getuid(), gid=os.getgid(), host=FakeHost(), boot_id=lambda: boot_id)
        dispatcher.mounts = self.mounts
        dispatcher.accounts = self.app.accounts
        if boot:
            dispatcher.boot()
            self.app.boot_id = dispatcher.boot_id
        dispatcher.unlink(b.ACTIVE)
        with mock.patch.object(b.os, "execve") as execute, contextlib.redirect_stdout(io.StringIO()) as output:
            dispatcher.dispatch()
        root = b.INFRA + "/" + runtime_id
        execute.assert_called_once_with(root + "/bin/node", [root + "/bin/node", root + "/lib/zeros/cloud-worker-supervisor.mjs"], b.ENV)
        self.assertEqual(json.loads(output.getvalue())["ok"], True)
        active = json.loads(dispatcher.path(b.ACTIVE).read_bytes())
        self.assertEqual(active["runtimeId"], runtime_id)
        self.assertEqual(active["bootId"], boot_id)
        receipt = dispatcher.path(b.RECEIPTS + "/" + runtime_id + ".json").read_bytes()
        self.assertEqual(active["installerReceiptSha256"], digest(receipt))

    def test_live_synthetic_generator_installs_and_dispatches_before_and_after_boot(self):
        spec = importlib.util.spec_from_file_location("synthetic_runtime", HERE / "synthetic_runtime.py")
        synthetic = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(synthetic)
        official = self.root / "node.tar.xz"
        node_bytes = b"test-only node fixture"
        with tarfile.open(official, mode="w:xz") as archive:
            node = tarfile.TarInfo("node-v22.23.1-linux-x64/bin/node")
            node.size = len(node_bytes)
            archive.addfile(node, io.BytesIO(node_bytes))
        output = self.root / "synthetic"
        original = None
        runtime_ids = []
        for variant in ("a", "a", "b", "c"):
            descriptor = synthetic.build(official, digest(official.read_bytes()), "1" * 40, variant, output)
            self.payload = (output / (variant + ".tar.gz")).read_bytes()
            with tarfile.open(fileobj=io.BytesIO(self.payload), mode="r:gz") as archive:
                link = archive.getmember("worker/variant-link.txt")
                self.assertTrue(link.issym())
                self.assertEqual(link.mode, 0o555)
            if variant == "a":
                if original is not None:
                    self.assertEqual(self.payload, original)
                original = self.payload
            self.value["runtime"] = descriptor
            with no_directory_renames():
                self.install()
            self.assertEqual((self.runtime() / "bin/node").read_bytes(), node_bytes)
            self.assertEqual((self.runtime() / "worker/variant-link.txt").read_text(), variant)
            self.app.verify_runtime(descriptor["runtimeId"], full=True)
            runtime_ids.append(descriptor["runtimeId"])
        self.assertEqual(len(set(runtime_ids)), 3)
        self.assert_fresh_dispatch(runtime_ids[-1])
        self.assert_fresh_dispatch(runtime_ids[-1], boot=True)

    def test_dispatch_handles_symlinks_in_each_executable_inventory_directory(self):
        def add_links(manifest):
            manifest["files"].extend([
                {"path": "bin/node-alias", "type": "symlink", "target": "node"},
                {"path": "bin/lib-alias", "type": "symlink", "target": "../lib"},
                {"path": "lib/zeros/setup-alias.mjs", "type": "symlink", "target": "setup-cloud-workspace.mjs"},
                {"path": "worker/dist-engine/cli-alias.js", "type": "symlink", "target": "cli.js"},
                {"path": "worker/dist-engine/directory-alias", "type": "symlink", "target": "."},
            ])
            manifest["files"].sort(key=lambda entry: entry["path"].encode())
        self.payload, self.value, self.manifest = fixture(change=add_links)
        self.install()
        self.assert_fresh_dispatch(self.value["runtime"]["runtimeId"])
        self.assert_fresh_dispatch(self.value["runtime"]["runtimeId"], boot=True)

    def test_installer_checks_the_published_tree_before_switching_current(self):
        self.install()
        previous = self.app.current()
        self.payload, self.value, self.manifest = fixture(extra={"worker/new.txt": b"next runtime"})
        destination = str(self.runtime())
        original = b.os.listxattr

        def installed_only_error(fd):
            if os.readlink(f"/proc/self/fd/{fd}").startswith(destination + "/"):
                raise OSError(errno.EIO, "private-canary")
            return original(fd)

        with mock.patch.object(b.os, "listxattr", side_effect=installed_only_error):
            with self.assertRaises(OSError):
                self.install()
        self.assertEqual(self.app.current(), previous)
        self.assertEqual(self.app.stage, "verify_tree")
        self.app.verify_runtime(previous)

    def test_dispatch_verification_failure_prevents_restart_and_reports_failed_host(self):
        self.install()
        node = self.runtime() / "bin/node"
        node.chmod(0o755)
        node.write_bytes(b"x" * node.stat().st_size)
        node.chmod(0o555)
        with mock.patch.object(b.os, "execve") as execute:
            code, output = self.cli(["dispatch"])
        execute.assert_not_called()
        self.assertEqual(code, 65)
        self.assertEqual(json.loads(output), {"schema": "zeros.diagnostic/v1", "component": "bootstrap",
            "stage": "verify_tree", "ok": False, "exitCode": 65, "timedOut": False, "failedChecks": ["file_digest"]})
        self.app.host = b.SystemHost()
        with mock.patch.object(b.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=b"failed\n")):
            status_code, status = self.cli(["status"])
        self.assertEqual(status_code, 0)
        self.assertEqual(json.loads(status)["hostState"], "failed")
        evidence = json.loads((self.root / "run/zeros/bootstrap-failures.jsonl").read_bytes().splitlines()[-1])
        self.assertEqual(evidence["failedChecks"], ["file_digest"])

    def test_install_host_start_resets_an_exhausted_restart_budget(self):
        self.install()
        limited = True

        def control(action, *_args):
            nonlocal limited
            if action == "reset-failed":
                limited = False
            return mock.Mock(returncode=1 if action == "start" and limited else 0, stdout=b"active\n")

        host = b.SystemHost()
        with mock.patch.object(host, "control", side_effect=control):
            host.start(self.app, self.app.current())
        self.assertFalse(limited)

    def test_install_receipt_active_and_cache_rehash(self):
        self.assertEqual(self.install(), 0)
        rid = self.value["runtime"]["runtimeId"]
        self.assertEqual(os.readlink(self.root / "opt/zeros/current"), "../zeros-infra/" + rid)
        self.assertFalse(os.path.lexists(self.root / "opt/zeros/previous"))
        receipt_path = self.root / "srv/zeros/runtime-installs" / (rid + ".json")
        receipt = json.loads(receipt_path.read_bytes())
        self.assertEqual(set(receipt), {"schema", "archiveSha256", "baseCompatibilityId", "bootstrapVersion",
                                      "expandedBytes", "fileCount", "installedAt", "manifestSha256", "runtimeId"})
        self.assertEqual(receipt["fileCount"], sum(entry["type"] == "file" for entry in self.manifest["files"]))
        active = json.loads((self.root / "run/zeros/active-runtime.json").read_bytes())
        self.assertEqual(active["installerReceiptSha256"], digest(receipt_path.read_bytes()))
        self.assertEqual(active["root"], "/opt/zeros-infra/" + rid)
        self.assertEqual(active["bootId"], BOOT)
        self.assertEqual(self.install(), 0)
        self.assertEqual(self.downloads, 1)
        target = self.runtime() / "worker/data.txt"
        target.chmod(0o644)
        target.write_bytes(b"corrupted data!\n")
        target.chmod(0o555)
        with self.assertRaises(b.Failure):
            self.install()

    def test_setup_payload_unchanged_and_exit_mirrored(self):
        self.value.update(purpose="workspace-setup", setup="eyJmaXh0dXJlIjp0cnVlfQ")
        self.host.setup_code = 37
        self.host.setup_checks = ["generation_pin"]
        with self.assertRaises(b.Failure) as caught:
            self.install()
        self.assertEqual(caught.exception.code, 37)
        self.assertEqual(caught.exception.checks, ["setup_exit"])
        self.assertEqual(self.app.stage, "run_setup")
        self.assertEqual(self.host.calls[-1], ("setup", str(self.runtime()), self.value["setup"]))

    def test_installer_diagnostic_vocabulary_excludes_nested_checks(self):
        expected = {
            "input_schema", "input_too_large", "artifact_host", "artifact_expired", "insufficient_space", "cache_conflict",
            "http_status", "download_truncated", "archive_digest", "archive_size", "manifest_digest", "manifest_schema",
            "bootstrap_protocol", "archive_paths", "archive_member_type", "file_inventory", "file_digest", "file_mode",
            "symlink_escape", "root_ownership", "hard_link", "pointer_publish", "host_start", "setup_exit", "timeout",
            "process_signal", "diagnostic_missing", "lock_busy", "base_compatibility", "cgroup_retired",
        }
        for check in expected | {"generation_pin", "cgroup_controllers", "uid_map"}:
            with self.subTest(check=check), contextlib.redirect_stdout(io.StringIO()) as output:
                b.diagnostic("installer", "run_setup", 1, b.Failure(check))
                value = json.loads(output.getvalue())
                self.assertTrue(set(value["failedChecks"]) <= expected)
                if check in expected:
                    self.assertEqual(value["failedChecks"], [check])

    def test_b1_golden_descriptors_inputs_manifests_and_diagnostics(self):
        self.assert_golden_contracts(GOLDEN)

    def test_b1_golden_harness_exercises_shared_directory_and_fallback(self):
        repository = self.root / "fixture-repository"
        fallback = HERE / "fixtures/cloud-runtime"
        self.assertEqual(golden_directory(repository), fallback)
        self.assert_golden_contracts(golden_directory(repository))
        shared = repository / "packages/protocol/src/__tests__/fixtures/cloud-runtime"
        shutil.copytree(fallback, shared)
        self.assertEqual(golden_directory(repository), shared)
        self.assert_golden_contracts(golden_directory(repository))

    def assert_golden_contracts(self, directory):
        catalog = json.loads((directory / "cases.json").read_bytes())
        descriptor = json.loads((directory / "descriptor.valid.json").read_bytes())
        # Admission owns canonical serialization. The base checks its pinned
        # raw digest, including these byte-only changes, without reserializing.
        changed_bytes = {"manifest.invalid-newline.json", "manifest.invalid-key-order.json",
                         "manifest.invalid-escaped-key.json", "manifest.invalid-exponent.json"}
        consumed = set()
        for case in catalog["cases"]:
            kind = case["contract"]
            if kind not in {"manifest", "descriptor", "install", "diagnostic"}:
                continue
            with self.subTest(directory=directory.name, fixture=case["file"]):
                consumed.add(kind)
                raw = (directory / case["file"]).read_bytes()
                value = json.loads(raw)
                if kind == "manifest":
                    self.assertEqual(digest(raw), case["manifestSha256"])
                    desc = dict(descriptor)
                    desc.update(expandedBytes=sum(entry.get("size", 0) for entry in value["files"] if entry["type"] == "file"),
                                sourceCommit=value["source"]["commit"], nodeModulesAbi=value["platform"]["nodeModulesAbi"],
                                bootstrapProtocolVersion=value["protocols"]["bootstrap"], engineProtocolVersion=value["protocols"]["engine"])
                    if case["file"] not in changed_bytes:
                        desc.update(manifestSha256=case["manifestSha256"], runtimeId="r1-" + case["manifestSha256"])
                    if case["valid"]:
                        b.validate_descriptor(desc)
                        if value["platform"]["nodeModulesAbi"] != 127:
                            # Shared-schema ABI bounds do not change this base's
                            # Node 22 ABI pin. Check the rejection, then exercise
                            # the remaining boundary fields with that pin alone
                            # normalized and its raw digest recomputed.
                            with self.assertRaises(b.Failure) as caught:
                                b.validate_manifest(raw, desc, self.app.compat)
                            self.assertEqual(caught.exception.checks, ["manifest_schema"])
                            value["platform"]["nodeModulesAbi"] = 127
                            raw = canonical(value)
                            desc.update(nodeModulesAbi=127, manifestSha256=digest(raw), runtimeId="r1-" + digest(raw))
                    operation = lambda: b.validate_manifest(raw, desc, self.app.compat)
                elif kind == "descriptor":
                    operation = lambda: b.validate_descriptor(value)
                elif kind == "install":
                    operation = lambda: b.validate_input(encoded(value), self.app.compat, NOW)
                else:
                    self.assertEqual(value["component"], "installer")
                    failure = b.Failure(value["failedChecks"][0], code=value["exitCode"], checks=value["failedChecks"][1:])
                    with contextlib.redirect_stdout(io.StringIO()) as output:
                        b.diagnostic("installer", value["stage"], value["exitCode"], failure)
                    emitted = json.loads(output.getvalue())
                    self.assertEqual(emitted == value, case["valid"])
                    self.assertTrue(set(emitted["failedChecks"]) <= b.INSTALLER_CHECKS)
                    continue
                if case["valid"]:
                    operation()
                else:
                    with self.assertRaises(b.Failure):
                        operation()
        self.assertEqual(consumed, {"manifest", "descriptor", "install", "diagnostic"})

    def test_b1_setup_failure_becomes_only_installer_setup_exit(self):
        golden = json.loads((GOLDEN / "diagnostic.invalid-installer-forwarded-setup-check.json").read_bytes())
        self.value.update(purpose="workspace-setup", setup="eyJmaXh0dXJlIjp0cnVlfQ")
        self.host.setup_code = golden["exitCode"]
        self.host.setup_checks = golden["failedChecks"]
        with self.assertRaises(b.Failure) as caught:
            self.install()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            b.diagnostic("installer", self.app.stage, caught.exception.code, caught.exception)
        self.assertEqual(json.loads(output.getvalue()), {**golden, "failedChecks": ["setup_exit"]})

    def cli(self, argv=None):
        with binary_stdout() as output, \
             mock.patch.object(b, "Bootstrap", return_value=self.app), \
             mock.patch.object(b.os, "geteuid", return_value=0), \
             mock.patch.object(b.os, "umask"), \
             mock.patch.object(b.signal, "signal"), mock.patch.object(b.signal, "alarm"), \
             mock.patch.object(b.sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(encoded(self.value)))):
            code = b.main(["install", "--stdin"] if argv is None else argv)
        return code, output.getvalue()

    def test_cli_preserves_legacy_helper_stdout_before_exactly_one_installer_diagnostic(self):
        self.value.update(purpose="workspace-setup", setup="e30")
        for code, ending in ((0, ""), (37, "\n"), (0, "\r\n")):
            with self.subTest(code=code, ending=ending):
                legacy = json.dumps({"version": 1, "audience": "zeros-cloud-workspace-setup-result-v1",
                                     "outcome": "ready" if code == 0 else "error"}) + ending
                program = "import sys; assert sys.stdin.read()=='e30'; sys.stderr.write('private-canary'); sys.stdout.write(" + repr(legacy) + "); sys.exit(" + str(code) + ")"
                with mock.patch.object(self.host, "setup", side_effect=lambda _root, payload: b.run_setup(
                        [sys.executable, "-I", "-c", program], payload, timeout=5)):
                    actual, output = self.cli()
                self.assertEqual(actual, code)
                separator = b"" if legacy.endswith("\n") else b"\n"
                expected = {"schema": "zeros.diagnostic/v1", "component": "installer", "stage": "done" if code == 0 else "run_setup",
                            "ok": code == 0, "exitCode": code, "timedOut": False, "failedChecks": [] if code == 0 else ["setup_exit"]}
                self.assertEqual(output, legacy.encode() + separator + b.packed(expected) + b"\n")
                self.assertNotIn(b"private-canary", output)

    def test_cli_failure_before_setup_prints_only_installer_diagnostic(self):
        self.value.update(purpose="workspace-setup", setup="e30")
        self.payload = b"bad archive"
        with mock.patch.object(self.host, "setup") as setup:
            code, output = self.cli()
        self.assertNotEqual(code, 0)
        setup.assert_not_called()
        self.assertEqual(len(output.splitlines()), 1)
        self.assertEqual(json.loads(output)["component"], "installer")

    def test_input_is_strict_bounded_and_has_no_extra_authority(self):
        for change, check in [
            (lambda v: v.update(command="private-canary"), "input_schema"),
            (lambda v: v.update(setup="e30"), "input_schema"),
            (lambda v: v.update(purpose="workspace-setup"), "input_schema"),
            (lambda v: v["runtime"].update(archiveBytes=True), "input_schema"),
            (lambda v: v["runtime"].update(runtimeId="r1-" + "a" * 64), "input_schema"),
            (lambda v: v["artifact"].update(expiresAt="2026-10-03T23:59:59Z"), "artifact_expired"),
            (lambda v: v["artifact"].update(expiresAt="2026-10-04T00:16:00Z"), "artifact_expired"),
        ]:
            with self.subTest(check=check):
                original = copy.deepcopy(self.value)
                change(self.value)
                self.reject(check)
                self.value = original
        for raw in (b"e30=", b"!", b"a" * (65536 + 1), base64.urlsafe_b64encode(b'{"schema":1,"schema":2}').rstrip(b"=")):
            with self.assertRaises(b.Failure):
                self.app.install(raw)

    def test_artifact_hosts_and_redirects_fail_closed(self):
        for url in ["http://fixture.r2.cloudflarestorage.com/x", "https://r2.cloudflarestorage.com/x",
                    "https://fixture.r2.cloudflarestorage.com.evil.test/x", "https://user@fixture.r2.cloudflarestorage.com/x",
                    "https://fixture.r2.cloudflarestorage.com:444/x", "https://fixture.r2.cloudflarestorage.com/x#secret"]:
            with self.subTest(url=url):
                self.value["artifact"]["url"] = url
                self.reject("artifact_host")
        response = mock.MagicMock(status=302)
        connection = mock.MagicMock()
        connection.getresponse.return_value = response
        with mock.patch.object(b.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaises(b.Failure) as caught:
                b.download_https({"url": "https://fixture.r2.cloudflarestorage.com/a"}, io.BytesIO(), self.value["runtime"])
        self.assertEqual(caught.exception.checks, ["http_status"])
        self.assertEqual(connection.request.call_count, 1)

    def test_archive_digest_and_size_checked_before_parsing(self):
        self.payload = b"private-canary"
        self.reject("archive_size")
        self.value["runtime"]["archiveBytes"] = len(self.payload)
        self.reject("archive_digest")

    def test_malformed_manifest_and_archive_members(self):
        cases = [
            (lambda m: m.update(extra=True), None, "manifest_schema"),
            (lambda m: m["platform"].update(nodeModulesAbi=128), None, "manifest_schema"),
            (lambda m: m["files"][0].update(path="../escape"), None, "archive_paths"),
            (lambda m: m["files"][0].update(path="/escape"), None, "archive_paths"),
            (lambda m: m["files"].append(m["files"][0]), None, "file_inventory"),
            (None, lambda i: setattr(i, "type", tarfile.LNKTYPE), "archive_member_type"),
            (None, lambda i: setattr(i, "type", tarfile.FIFOTYPE), "archive_member_type"),
            (None, lambda i: setattr(i, "type", tarfile.CHRTYPE), "archive_member_type"),
            (None, lambda i: setattr(i, "mode", 0o4755), "file_mode"),
            (None, lambda i: setattr(i, "uid", 10001), "root_ownership"),
            (None, lambda i: i.pax_headers.update({"SCHILY.xattr.security.capability": "private-canary"}), "archive_member_type"),
        ]
        for change, transform, check in cases:
            with self.subTest(check=check):
                self.payload, self.value, _ = fixture(change=change, transform=transform)
                self.reject(check)

    def test_optional_self_test_can_be_omitted_but_every_listed_entrypoint_must_exist(self):
        def omit(manifest):
            manifest["entrypoints"].pop("selfTest")
            manifest["files"] = [entry for entry in manifest["files"] if entry["path"] != b.ENTRYPOINTS["selfTest"]]
        self.payload, self.value, _ = fixture(change=omit)
        self.assertEqual(self.install(), 0)
        self.app.verify_runtime(self.app.current())
        def missing_listed(manifest):
            manifest["files"] = [entry for entry in manifest["files"] if entry["path"] != b.ENTRYPOINTS["selfTest"]]
        self.payload, self.value, _ = fixture(change=missing_listed)
        with self.assertRaises(b.Failure) as caught:
            self.install()
        self.assertEqual(caught.exception.checks, ["file_inventory"])

    def test_agent_version_strings_follow_the_shared_bounded_package_tag_contract(self):
        for version in ("stable", "2026.03.30-d6afddd", "v1.2.3", "a" * 64):
            with self.subTest(version=version):
                _, value, manifest = fixture(change=lambda m: m["agents"]["cursor"].update(sdk=version))
                b.validate_manifest(canonical(manifest), value["runtime"], self.app.compat)
        for version in ("", "a" * 65, "-1.0", "a\nb", "1.0.0+meta", "a/b"):
            with self.subTest(version=version):
                _, value, manifest = fixture(change=lambda m: m["agents"]["cursor"].update(sdk=version))
                with self.assertRaises(b.Failure):
                    b.validate_manifest(canonical(manifest), value["runtime"], self.app.compat)

    def test_paths_and_link_targets_reject_nul_backslash_cr_and_lf(self):
        for char in ("\0", "\\", "\r", "\n"):
            with self.subTest(char=repr(char)):
                with self.assertRaises(b.Failure) as caught:
                    b.safe_path("worker/a" + char + "b")
                self.assertEqual(caught.exception.checks, ["archive_paths"])
                # The inventory contains the same target, so this tests the
                # target's lexical syntax rather than a missing-file failure.
                with self.assertRaises(b.Failure) as caught:
                    b.validate_links([{"path": "a" + char + "b", "type": "file"},
                                      {"path": "link", "type": "symlink", "target": "a" + char + "b"}])
                self.assertEqual(caught.exception.checks, ["symlink_escape"])

    def test_symlink_resolution_is_limited_to_64_links(self):
        def links(count):
            return [{"path": "file", "type": "file"}] + [
                {"path": "link" + str(i), "type": "symlink", "target": "link" + str(i + 1) if i + 1 < count else "file"}
                for i in range(count)]
        b.validate_links(links(64))
        with self.assertRaises(b.Failure) as caught:
            b.validate_links(links(65))
        self.assertEqual(caught.exception.checks, ["symlink_escape"])

    def test_symlink_tar_permission_bits_are_ignored(self):
        def add_link(manifest):
            manifest["files"].append({"path": "worker/link", "type": "symlink", "target": "data.txt"})
            manifest["files"].sort(key=lambda entry: entry["path"].encode())
        for mode in (0o555, 0o777, 0, 0o4755):
            with self.subTest(mode=oct(mode)):
                def permissions(info):
                    if info.issym():
                        info.mode = mode
                # Distinct manifests force extraction for each archive mode.
                self.payload, self.value, self.manifest = fixture(extra={"worker/mode": str(mode).encode()},
                                                                 change=add_link, transform=permissions)
                self.assertEqual(self.install(), 0)
                self.assertEqual(os.readlink(self.runtime() / "worker/link"), "data.txt")
                receipt = json.loads((self.root / "srv/zeros/runtime-installs" / (self.app.current() + ".json")).read_bytes())
                self.assertEqual(receipt["fileCount"], sum(entry["type"] == "file" for entry in self.manifest["files"]))

    def test_long_pax_paths_are_supported(self):
        name = "worker/" + "a" * 110 + "/data"
        self.payload, self.value, _ = fixture(extra={name: b"long name"})
        self.install()
        self.assertEqual((self.runtime() / name).read_bytes(), b"long name")

    def test_deep_archive_is_rejected_before_extraction_and_previous_runtime_boots(self):
        self.install()
        previous = self.app.current()
        self.payload, self.value, _ = fixture(extra={"worker/" + "a/" * 1050 + "file": b"nested"})
        try:
            with mock.patch.object(self.app, "extract", wraps=self.app.extract) as extract:
                with self.assertRaises(b.Failure) as caught:
                    self.install()
                self.assertEqual(caught.exception.checks, ["archive_paths"])
                extract.assert_not_called()
            self.assertFalse(self.runtime().exists())
            self.assertEqual(list((self.root / "opt/zeros-infra/.staging").iterdir()), [])
            self.app.boot()
            self.app.verify_runtime(previous)
            self.assertEqual(self.app.current(), previous)
        finally:
            # The regression's old implementation leaves a tree too deep for
            # TemporaryDirectory's recursive cleanup on Python 3.9.
            subprocess.run(["rm", "-rf", "--", str(self.root / "opt/zeros-infra/.staging")], check=True)

    def test_staging_cleanup_handles_legacy_deep_trees_without_following_links(self):
        staging = self.root / "opt/zeros-infra/.staging"
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_bytes(b"keep")
        fd = os.open(staging, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for _ in range(1050):
                os.mkdir("a", dir_fd=fd)
                child = os.open("a", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = child
            os.symlink(str(outside), "outside", dir_fd=fd)
        finally:
            os.close(fd)
        try:
            self.app.boot()
            self.assertEqual(list(staging.iterdir()), [])
            self.assertEqual((outside / "keep").read_bytes(), b"keep")
            self.install()
        finally:
            subprocess.run(["rm", "-rf", "--", str(staging)], check=True)

    def test_symlink_targets_need_lexical_as_well_as_resolved_containment(self):
        name = "manifest.invalid-lexical-symlink-escape.json"
        file = GOLDEN / name
        raw = (file if file.exists() else HERE / "fixtures" / name).read_bytes()
        descriptor = json.loads((GOLDEN / "descriptor.valid.json").read_bytes())
        descriptor.update(runtimeId="r1-" + digest(raw), manifestSha256=digest(raw))
        with self.assertRaises(b.Failure) as caught:
            b.validate_manifest(raw, descriptor, self.app.compat)
        self.assertEqual(caught.exception.checks, ["symlink_escape"])

    def test_expanding_symlink_cycle_is_bounded_in_a_memory_limited_process(self):
        program = """import importlib.util, resource, sys
resource.setrlimit(resource.RLIMIT_AS, (192 * 1024**2, 192 * 1024**2))
spec = importlib.util.spec_from_file_location('bootstrap', sys.argv[1])
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
try:
    b.validate_links([{'path': 'a', 'type': 'symlink', 'target': '/'.join(['a'] * 2048)}])
except b.Failure as error:
    assert error.checks == ['symlink_escape']
else:
    raise AssertionError('expanding cycle accepted')
"""
        result = subprocess.run([sys.executable, "-I", "-c", program, str(HERE.parent / "bootstrap.py")],
                                capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_symlinks_are_last_and_confined_even_through_other_links(self):
        def add_links(m):
            m["files"].extend([{"path": "worker/alias", "type": "symlink", "target": "data.txt"},
                               {"path": "worker/chain", "type": "symlink", "target": "alias"}])
            m["files"].sort(key=lambda e: e["path"].encode())
        self.payload, self.value, _ = fixture(change=add_links)
        self.install()
        self.assertEqual(os.readlink(self.runtime() / "worker/chain"), "alias")
        # Revisiting a link after its expansion completed is not a cycle.
        b.validate_links([{"path": "worker", "type": "dir"}, {"path": "worker/data.txt", "type": "file"},
                          {"path": "worker/a", "type": "symlink", "target": "."},
                          {"path": "worker/z", "type": "symlink", "target": "a/a/data.txt"}])
        for target in ("../../outside", "/etc/passwd", "chain"):
            def bad(m):
                add_links(m)
                next(e for e in m["files"] if e["path"] == "worker/alias")["target"] = target
            self.payload, self.value, _ = fixture(change=bad)
            with self.assertRaises(b.Failure) as caught:
                self.install()
            self.assertEqual(caught.exception.checks, ["symlink_escape"])

    def test_dispatch_stats_every_file_and_hashes_executable_closure(self):
        self.install()
        rid = self.value["runtime"]["runtimeId"]
        target = self.runtime() / "worker/data.txt"
        original = target.read_bytes()
        target.chmod(0o755)
        with self.assertRaises(b.Failure):
            self.app.verify_runtime(rid, full=False)
        target.chmod(0o555)
        target.chmod(0o755)
        target.write_bytes(b"x" * len(original))
        target.chmod(0o555)
        self.app.verify_runtime(rid, full=False)
        with self.assertRaises(b.Failure):
            self.app.verify_runtime(rid, full=True)
        target = self.runtime() / "worker/dist-engine/cli.js"
        original = target.read_bytes()
        target.chmod(0o755)
        target.write_bytes(b"x" * len(original))
        target.chmod(0o555)
        with self.assertRaises(b.Failure) as caught:
            self.app.verify_runtime(rid, full=False)
        self.assertEqual(caught.exception.checks, ["file_digest"])

    def test_hard_links_extra_files_and_symlink_ancestry_are_rejected(self):
        self.install()
        rid = self.value["runtime"]["runtimeId"]
        target = self.runtime() / "bin/node"
        os.link(target, self.root / "alias")
        with self.assertRaises(b.Failure) as caught:
            self.app.verify_runtime(rid)
        self.assertEqual(caught.exception.checks, ["hard_link"])
        (self.root / "alias").unlink()
        (self.runtime() / "extra").touch()
        with self.assertRaises(b.Failure) as caught:
            self.app.verify_runtime(rid)
        self.assertEqual(caught.exception.checks, ["file_inventory"])
        (self.runtime() / "extra").unlink()
        target.rename(self.root / "outside")
        target.symlink_to(self.root / "outside")
        with self.assertRaises(b.Failure):
            self.app.verify_runtime(rid)

    def test_no_follow_root_ancestry_and_unexpected_alias(self):
        (self.root / "zeros").unlink()
        (self.root / "zeros").mkdir()
        with self.assertRaises(b.Failure):
            self.app.boot()
        (self.root / "zeros").rmdir()
        (self.root / "opt/zeros-infra").rename(self.root / "outside")
        (self.root / "opt/zeros-infra").symlink_to(self.root / "outside")
        with self.assertRaises(b.Failure):
            self.install()

    def test_previous_is_kept_and_failed_retirement_does_not_switch(self):
        self.install()
        old = os.readlink(self.root / "opt/zeros/current")
        self.payload, self.value, _ = fixture(extra={"worker/second": b"second"})
        with mock.patch.object(self.host, "stop", side_effect=b.Failure("cgroup_retired")):
            with self.assertRaises(b.Failure):
                self.install()
        self.assertEqual(os.readlink(self.root / "opt/zeros/current"), old)
        self.install()
        self.assertEqual(os.readlink(self.root / "opt/zeros/previous"), old)

    def test_missing_or_mismatched_receipt_requires_fresh_extraction(self):
        self.install()
        rid = self.value["runtime"]["runtimeId"]
        receipt = self.root / "srv/zeros/runtime-installs" / (rid + ".json")
        marker = self.runtime().with_suffix(".incomplete")
        for mismatch in ("missing", "invalid", "baseCompatibilityId", "archiveSha256", "fileCount"):
            with self.subTest(mismatch=mismatch):
                value = json.loads(receipt.read_bytes())
                if mismatch == "missing":
                    receipt.unlink()
                elif mismatch == "invalid":
                    receipt.write_bytes(b"{}")
                else:
                    value[mismatch] = value[mismatch] + 1 if mismatch == "fileCount" else "f" * 64
                    receipt.write_bytes(canonical(value))
                stale = self.runtime() / "uncommitted-file"
                stale.write_bytes(b"discard incomplete contents")
                extract = self.app.extract

                def fresh(*args):
                    self.assertEqual(args[1], b.INFRA + "/" + rid)
                    self.assertIsNone(self.app.current())
                    self.assertNotEqual(self.host.state, "active")
                    self.assertTrue(marker.is_file())
                    self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(list(self.runtime().iterdir()), [])
                    return extract(*args)

                before = self.downloads
                with mock.patch.object(self.app, "extract", side_effect=fresh), no_directory_renames():
                    self.assertEqual(self.install(), 0)
                self.assertEqual(self.downloads, before + 1)
                self.assertFalse(marker.exists())
                self.assertFalse(stale.exists())
                self.app.verify_runtime(rid)
                self.assert_fresh_dispatch(rid)

    def test_missing_runtime_with_orphan_receipt_is_reextracted(self):
        self.install()
        rid = self.app.current()
        shutil.rmtree(self.runtime())
        self.assertEqual(self.install(), 0)
        self.assertEqual(self.downloads, 2)
        self.app.verify_runtime(rid)
        self.assert_fresh_dispatch(rid, boot=True)

    def test_incomplete_current_is_not_removed_until_host_retirement_succeeds(self):
        self.install()
        rid = self.app.current()
        receipt = self.root / "srv/zeros/runtime-installs" / (rid + ".json")
        receipt.unlink()
        with mock.patch.object(self.host, "stop", side_effect=b.Failure("cgroup_retired")):
            with self.assertRaises(b.Failure) as caught:
                self.install()
        self.assertEqual(caught.exception.checks, ["cgroup_retired"])
        self.assertEqual(self.app.current(), rid)
        self.assertEqual((self.runtime() / "bin/node").read_bytes(), b"synthetic node\n")
        self.assertEqual(self.downloads, 1)

    def test_boot_removes_marked_current_even_with_a_matching_receipt(self):
        self.install()
        previous = self.app.current()
        self.payload, self.value, _ = fixture(extra={"worker/next": b"second"})
        self.install()
        rid = self.app.current()
        marker = self.runtime().with_suffix(".incomplete")
        marker.write_bytes(b"")
        marker.chmod(0o600)
        with self.assertRaises(b.Failure) as caught:
            self.app.verify_runtime(rid)
        self.assertEqual(caught.exception.checks, ["cache_conflict"])
        self.app.boot()
        self.assertIsNone(self.app.current())
        self.assertEqual(self.app.current("previous"), previous)
        self.assertEqual(self.app.status()["hostState"], "waiting_for_runtime")
        self.assertFalse(self.runtime().exists())
        self.assertFalse(marker.exists())
        self.assertFalse(self.app.path(b.RECEIPTS + "/" + rid + ".json").exists())
        self.assertFalse(self.app.path(b.ACTIVE).exists())
        self.app.verify_runtime(previous)
        before = self.downloads
        self.assertEqual(self.install(), 0)
        self.assertEqual(self.downloads, before + 1)
        self.assertEqual(self.app.current("previous"), previous)
        self.assert_fresh_dispatch(rid, boot=True)

    def test_boat_restored_empty_runtime_with_receipt_is_reextracted(self):
        self.install()
        previous = self.app.current()
        self.payload, self.value, _ = fixture(extra={"worker/next": b"second"})
        self.install()
        rid = self.app.current()
        # Measured Boat failure: current and receipt survive, but a renamed
        # runtime directory returns with none of its children after restore.
        for child in self.runtime().iterdir():
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
        self.assertEqual(self.app.current(), rid)
        self.assertTrue(self.app.path(b.RECEIPTS + "/" + rid + ".json").exists())
        self.app.boot()
        self.assertIsNone(self.app.current())
        self.assertFalse(self.runtime().exists())
        self.app.verify_runtime(previous)
        before = self.downloads
        with no_directory_renames():
            self.install()
        self.assertEqual(self.downloads, before + 1)
        self.assertEqual(self.app.current("previous"), previous)
        self.assert_fresh_dispatch(rid, boot=True)

    def test_incomplete_cleanup_can_itself_be_interrupted(self):
        for boundary in ("receipt_removed", "tree_removed"):
            with self.subTest(boundary=boundary):
                self.payload, self.value, _ = fixture(extra={"worker/version": boundary.encode()})
                self.install()
                rid = self.app.current()
                marker = self.runtime().with_suffix(".incomplete")
                marker.write_bytes(b"")
                marker.chmod(0o600)
                unlink, remove_entries = self.app.unlink, self.app.remove_entries

                def interrupt_unlink(absolute):
                    unlink(absolute)
                    if boundary == "receipt_removed" and absolute == b.RECEIPTS + "/" + rid + ".json":
                        raise Crash()

                def interrupt_remove(root, names):
                    remove_entries(root, names)
                    if boundary == "tree_removed" and root == b.INFRA:
                        raise Crash()

                with mock.patch.object(self.app, "unlink", side_effect=interrupt_unlink), \
                        mock.patch.object(self.app, "remove_entries", side_effect=interrupt_remove), self.assertRaises(Crash):
                    self.app.boot()
                self.assertTrue(marker.exists())
                self.app.boot()
                self.assertFalse(marker.exists())
                self.assertFalse(self.runtime().exists())
                self.assertIsNone(self.app.current())
                self.assertEqual(self.install(), 0)
                self.assert_fresh_dispatch(rid)

    def test_incomplete_final_tree_cleanup_is_iterative_and_never_follows_links(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_bytes(b"keep")
        self.runtime().mkdir()
        fd = os.open(self.runtime(), os.O_RDONLY | os.O_DIRECTORY)
        try:
            for _ in range(1050):
                os.mkdir("a", dir_fd=fd)
                child = os.open("a", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = child
            os.symlink(str(outside), "outside", dir_fd=fd)
        finally:
            os.close(fd)
        try:
            self.app.boot()
            self.assertFalse(self.runtime().exists())
            self.assertEqual((outside / "keep").read_bytes(), b"keep")
            with no_directory_renames():
                self.install()
            self.assert_fresh_dispatch(self.app.current(), boot=True)
        finally:
            subprocess.run(["rm", "-rf", "--", str(self.runtime())], check=True)

    def test_incomplete_publication_is_retried_at_every_boundary_without_directory_renames(self):
        self.install()
        boundaries = ("incomplete_published", "runtime_created", "runtime_verified", "receipt_published", "incomplete_removed")
        for reboot in (False, True):
            for boundary in boundaries:
                with self.subTest(boundary=boundary, reboot=reboot):
                    previous = self.app.current()
                    self.payload, self.value, _ = fixture(extra={"worker/version": f"{boundary}-{reboot}".encode()})
                    rid = self.value["runtime"]["runtimeId"]
                    marker = self.runtime().with_suffix(".incomplete")

                    def crash(point):
                        if point == boundary:
                            raise Crash()

                    self.app.fault = crash
                    with no_directory_renames(), self.assertRaises(Crash):
                        self.install()
                    self.app.fault = lambda _: None
                    self.assertEqual(self.app.current(), previous)
                    self.assertEqual(marker.exists(), boundary != "incomplete_removed")
                    self.assertEqual(self.runtime().exists(), boundary != "incomplete_published")
                    self.app.verify_runtime(previous)
                    if boundary != "incomplete_removed":
                        with self.assertRaises(b.Failure) as caught:
                            self.app.verify_runtime(rid)
                        self.assertEqual(caught.exception.checks, ["cache_conflict"])
                    if reboot:
                        self.app.boot()
                        self.assertFalse(marker.exists())
                        self.assertEqual(self.runtime().exists(), boundary == "incomplete_removed")
                        self.assert_fresh_dispatch(previous)
                    before = self.downloads
                    with no_directory_renames():
                        self.assertEqual(self.install(), 0)
                    self.assertEqual(self.downloads, before + (boundary != "incomplete_removed"))
                    self.assertEqual(self.app.current("previous"), previous)
                    self.assertFalse(marker.exists())
                    self.assert_fresh_dispatch(rid, boot=True)

    def test_boot_epoch_is_once_per_boot_across_each_publication_boundary(self):
        for index, point in enumerate(("boot_intent_published", "boot_epoch_published", "boot_id_published"), 1):
            with self.subTest(point=point):
                self.app.boot_id = lambda: f"12345678-1234-4234-8234-{index:012d}"
                before = self.app.epoch()
                def crash(boundary):
                    if boundary == point:
                        raise Crash()
                self.app.fault = crash
                with self.assertRaises(Crash):
                    self.app.boot()
                self.app.fault = lambda _: None
                self.app.boot()
                self.app.boot()
                self.assertEqual(self.app.epoch(), before + 1)

    def test_download_timeouts_have_closed_timeout_semantics(self):
        connection = mock.MagicMock()
        response = connection.getresponse.return_value
        response.status = 200
        response.getheader.return_value = None
        response.read.side_effect = TimeoutError("https://private-canary.test/token")
        with mock.patch.object(b.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaises(b.Failure) as caught:
                b.download_https({"url": "https://fixture.r2.cloudflarestorage.com/a"}, io.BytesIO(), self.value["runtime"])
        self.assertEqual(caught.exception.checks, ["timeout"])
        self.assertTrue(caught.exception.timed_out)
        self.assertEqual(caught.exception.code, 124)

    def test_archive_member_inventory_global_pax_and_duplicate_pax_reject(self):
        original, self.value, _ = fixture()
        uncompressed = gzip.decompress(original)
        for malicious, check in [
            (tarfile.TarInfo.create_pax_global_header({"path": "private-canary"}) + uncompressed, "archive_member_type"),
            (uncompressed[:-1024] + b"not padding" + b"\0" * 1024, "file_inventory"),
        ]:
            with self.subTest(check=check):
                self.payload = gzip.compress(malicious, mtime=0)
                self.value["runtime"]["archiveBytes"] = len(self.payload)
                self.value["runtime"]["archiveSha256"] = digest(self.payload)
                with self.assertRaises(b.Failure):
                    self.install()
        with self.assertRaises(b.Failure) as caught:
            b.pax_records(b"9 path=a\n9 path=b\n")
        self.assertEqual(caught.exception.checks, ["archive_member_type"])

    def test_setup_output_is_bounded_without_parsing_a_new_helper_diagnostic(self):
        program = "import sys; sys.stdin.read(); sys.stdout.buffer.write(b'x'*(256*1024+1))"
        with binary_stdout() as output:
            with self.assertRaises(b.Failure) as caught:
                b.run_setup([sys.executable, "-I", "-c", program], "fixture", timeout=5)
            self.assertEqual(caught.exception.checks, ["setup_exit"])
        self.assertLessEqual(len(output.getvalue()), 256 * 1024 + 1)
        with binary_stdout(), self.assertRaises(b.Failure) as caught:
            b.run_setup([sys.executable, "-c", "import time; time.sleep(10)"], "fixture", timeout=0.05)
        self.assertEqual(caught.exception.code, 124)
        with binary_stdout():
            code, checks = b.run_setup([sys.executable, "-c", "import os,signal; os.kill(os.getpid(),signal.SIGTERM)"], "fixture", timeout=5)
        self.assertEqual(code, 143)
        self.assertEqual(checks, ["process_signal"])

    def test_extraction_failure_does_not_publish_a_runtime(self):
        self.payload, self.value, _ = fixture(change=lambda m: next(e for e in m["files"] if e["path"] == "worker/data.txt").update(sha256="f" * 64))
        self.reject("file_digest")
        self.assertEqual(list((self.root / "opt/zeros-infra/.staging").iterdir()), [])
        self.assertFalse(self.runtime().exists())

    def test_caps_and_writable_ancestry_fail_verification(self):
        self.install()
        with mock.patch.object(b.os, "listxattr", return_value=["security.capability"]):
            with self.assertRaises(b.Failure) as caught:
                self.app.verify_runtime(self.value["runtime"]["runtimeId"])
        self.assertEqual(caught.exception.checks, ["file_mode"])
        (self.root / "opt").chmod(0o775)
        with self.assertRaises(b.Failure) as caught:
            self.install()
        self.assertEqual(caught.exception.checks, ["file_mode"])
        (self.root / "opt").chmod(0o755)

    def test_crashes_at_durable_boundaries_reconcile_without_setup(self):
        self.install()
        old = self.value["runtime"]["runtimeId"]
        for boundary in ("incomplete_published", "runtime_created", "runtime_verified", "receipt_published", "incomplete_removed", "intent_published",
                         "previous_published", "current_published", "epoch_published", "intent_removed"):
            with self.subTest(boundary=boundary):
                self.payload, self.value, _ = fixture(extra={"worker/version": boundary.encode()})
                def fail(point):
                    if point == boundary:
                        raise Crash()
                self.app.fault = fail
                with self.assertRaises(Crash):
                    self.install()
                self.app.fault = lambda point: None
                calls = len(self.host.calls)
                self.app.boot()
                self.assertEqual(len(self.host.calls), calls)
                rid = self.app.current()
                self.assertIn(rid, (old, self.value["runtime"]["runtimeId"]))
                self.app.verify_runtime(rid)
                self.assertFalse((self.root / "srv/zeros/runtime-installs/switch-intent.json").exists())
                self.install()
                old = self.value["runtime"]["runtimeId"]

    def test_retry_reconciles_every_switch_boundary_without_reboot(self):
        self.install()
        for boundary in ("intent_published", "previous_published", "current_published", "epoch_published", "intent_removed"):
            with self.subTest(boundary=boundary):
                previous, before = self.app.current(), self.app.epoch()
                self.payload, self.value, _ = fixture(extra={"worker/version": boundary.encode()})
                def fail(point):
                    if point == boundary:
                        raise Crash()
                self.app.fault = fail
                with self.assertRaises(Crash):
                    self.install()
                self.app.fault = lambda _: None
                self.assertEqual(self.install(), 0)
                self.assertFalse((self.root / "srv/zeros/runtime-installs/switch-intent.json").exists())
                self.assertGreater(self.app.epoch(), before)
                self.assertEqual(self.app.current(), self.value["runtime"]["runtimeId"])
                self.assertEqual(self.app.current("previous"), previous)
                stable = self.app.epoch()
                self.app.boot()
                self.assertEqual(self.app.epoch(), stable)

    def test_disk_admission_and_concurrent_install_lock(self):
        with mock.patch.object(b.shutil, "disk_usage", return_value=mock.Mock(free=0)):
            self.reject("insufficient_space")
        with self.app.lock("runtime-install.lock"):
            self.reject("lock_busy")

    def test_cli_never_prints_untrusted_input_or_traceback(self):
        result = subprocess.run([sys.executable, "-I", str(HERE.parent / "bootstrap.py"), "invalid-private-canary"],
                                capture_output=True, input=b"private-canary", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        diagnostic = json.loads(result.stdout)
        self.assertEqual(diagnostic["schema"], "zeros.diagnostic/v1")
        self.assertNotIn(b"private-canary", result.stdout)

    def test_closed_output_pipe_does_not_leak_a_traceback(self):
        child = subprocess.Popen([sys.executable, "-I", str(HERE.parent / "bootstrap.py"), "invalid"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        child.stdout.close()
        error = child.stderr.read()
        child.wait(timeout=5)
        child.stderr.close()
        self.assertEqual(error, b"")


if __name__ == "__main__":
    unittest.main()
