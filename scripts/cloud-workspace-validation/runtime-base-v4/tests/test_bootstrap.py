"""Rootless security and interruption tests for the base-owned verifier.

The temporary root and host adapter are Python-only injection points, never CLI
options or environment variables accepted by the shipped root entry point.
"""
import base64
import copy
import datetime
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
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
    """Local contract mirror until B1's golden fixtures are merged."""
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
    manifest = json.loads((HERE / "fixtures" / "manifest.json").read_text())
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
                    info.type, info.mode, info.linkname = tarfile.SYMTYPE, 0o777, entry["target"]
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


class FakeHost:
    def __init__(self):
        self.calls = []
        self.state = "active"
        self.setup_code = 0
        self.setup_checks = []
        self.runtime = None

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
        bootstrap = self.root / "opt/zeros-bootstrap"
        bootstrap.mkdir(parents=True)
        compat = json.loads((HERE.parent / "compatibility.json").read_text())
        (bootstrap / "protected").write_bytes(b"base-owned")
        (bootstrap / "protected").chmod(0o555)
        compat["protectedFiles"] = [{"path": "/opt/zeros-bootstrap/protected", "mode": "0555", "sha256": digest(b"base-owned")}]
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

    def test_live_synthetic_generator_builds_deterministic_installable_archives(self):
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
            if variant == "a":
                if original is not None:
                    self.assertEqual(self.payload, original)
                original = self.payload
            self.value["runtime"] = descriptor
            self.install()
            self.assertEqual((self.runtime() / "bin/node").read_bytes(), node_bytes)
            self.app.verify_runtime(descriptor["runtimeId"], full=True)
            runtime_ids.append(descriptor["runtimeId"])
        self.assertEqual(len(set(runtime_ids)), 3)

    def test_install_receipt_active_and_cache_rehash(self):
        self.assertEqual(self.install(), 0)
        rid = self.value["runtime"]["runtimeId"]
        self.assertEqual(os.readlink(self.root / "opt/zeros/current"), "../zeros-infra/" + rid)
        self.assertFalse(os.path.lexists(self.root / "opt/zeros/previous"))
        receipt_path = self.root / "srv/zeros/runtime-installs" / (rid + ".json")
        receipt = json.loads(receipt_path.read_bytes())
        self.assertEqual(set(receipt), {"schema", "archiveSha256", "baseCompatibilityId", "bootstrapVersion",
                                      "expandedBytes", "fileCount", "installedAt", "manifestSha256", "runtimeId"})
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
        self.assertEqual(caught.exception.checks, ["setup_exit", "generation_pin"])
        self.assertEqual(self.host.calls[-1], ("setup", str(self.runtime()), self.value["setup"]))

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

    def test_long_pax_paths_are_supported(self):
        name = "worker/" + "a" * 110 + "/data"
        self.payload, self.value, _ = fixture(extra={name: b"long name"})
        self.install()
        self.assertEqual((self.runtime() / name).read_bytes(), b"long name")

    def test_symlinks_are_last_and_confined_even_through_other_links(self):
        def add_links(m):
            m["files"].extend([{"path": "worker/alias", "type": "symlink", "target": "data.txt"},
                               {"path": "worker/chain", "type": "symlink", "target": "alias"}])
            m["files"].sort(key=lambda e: e["path"].encode())
        self.payload, self.value, _ = fixture(change=add_links)
        self.install()
        self.assertEqual(os.readlink(self.runtime() / "worker/chain"), "alias")
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

    def test_missing_receipt_rebuilt_only_after_full_verification(self):
        self.install()
        rid = self.value["runtime"]["runtimeId"]
        receipt = self.root / "srv/zeros/runtime-installs" / (rid + ".json")
        receipt.unlink()
        self.install()
        self.assertTrue(receipt.exists())
        self.assertEqual(self.downloads, 1)

    def test_orphan_receipt_is_not_overwritten_by_a_new_download(self):
        self.install()
        shutil.rmtree(self.runtime())
        with self.assertRaises(b.Failure) as caught:
            self.install()
        self.assertEqual(caught.exception.checks, ["cache_conflict"])
        self.assertEqual(self.downloads, 1)

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

    def test_setup_output_is_bounded_validated_and_never_forwarded(self):
        closed = {"schema": "zeros.diagnostic/v1", "component": "setup", "stage": "done", "ok": False,
                  "exitCode": 37, "timedOut": False, "failedChecks": ["generation_pin"]}
        program = "import sys; sys.stdin.read(); sys.stderr.write('private-canary'); print('x'*100000); print(" + repr(json.dumps(closed)) + "); sys.exit(37)"
        code, checks = b.run_setup([sys.executable, "-c", program], "nested-fixture", timeout=5)
        self.assertEqual(code, 37)
        self.assertEqual(checks, ["generation_pin", "setup_exit"])
        code, checks = b.run_setup([sys.executable, "-c", "print('private-canary')"], "fixture", timeout=5)
        self.assertEqual(checks, ["diagnostic_missing"])
        with self.assertRaises(b.Failure) as caught:
            b.run_setup([sys.executable, "-c", "import time; time.sleep(10)"], "fixture", timeout=0.05)
        self.assertEqual(caught.exception.code, 124)
        code, checks = b.run_setup([sys.executable, "-c", "import os,signal; os.kill(os.getpid(),signal.SIGTERM)"], "fixture", timeout=5)
        self.assertEqual(code, 143)
        self.assertIn("process_signal", checks)

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
        for boundary in ("stage_fsynced", "runtime_renamed", "receipt_published", "intent_published",
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
