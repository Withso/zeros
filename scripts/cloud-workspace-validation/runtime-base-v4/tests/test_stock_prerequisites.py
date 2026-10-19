"""Read-only stock qualification, using synthetic files and command replies."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / "stock-prerequisites.py"
spec = importlib.util.spec_from_file_location("stock", SOURCE)
stock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stock)


class StockPrerequisiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "usr/local/lib").mkdir(parents=True)
        self.calls = []
        self.missing_package = None
        self.unsupported_cache = False
        for path in stock.BINARIES:
            self.write(path, b"fixture executable\n", 0o755)
        for path in stock.LIBRARIES.values():
            for library in path:
                self.write("/usr/lib/x86_64-linux-gnu/" + library, b"fixture library\n")
        # A minimal ELF64 executable with one PT_LOAD segment and no PT_INTERP.
        header = bytearray(120)
        header[:7] = b"\x7fELF\x02\x01\x01"
        struct.pack_into("<HHIQQQIHHHHHH", header, 16, 2, 62, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
        struct.pack_into("<I", header, 64, 1)
        self.write("/usr/bin/busybox", header, 0o755)
        self.write("/etc/ssl/certs/ca-certificates.crt", b"fixture CA\n")
        self.write("/sys/module/apparmor/parameters/enabled", b"Y\n")

    def write(self, path, data, mode=0o644):
        target = self.root / path.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(mode)
        return target

    def command(self, argv):
        self.calls.append(argv)
        if argv[0].endswith("/dpkg-query"):
            return "".join(package + "\t1.2.3-1\tamd64\tinstalled\n" for package in stock.PACKAGES
                           if package != self.missing_package).encode()
        if argv[0].endswith("/apparmor_parser"):
            return b"AppArmor parser version 4.0\n" if "--version" in argv else (
                b"usage\n" if self.unsupported_cache else b"  -K, --skip-cache Do not read or write the cache\n")
        if argv[0].endswith("/useradd"):
            return b"  -l, --no-log-init do not add the user to lastlog and faillog databases\n"
        if argv[0].endswith("/bwrap") and "--help" in argv:
            return b"--ro-bind --bind --unshare-user --unshare-ipc --unshare-uts --unshare-pid --unshare-cgroup --proc --dev --tmpfs --die-with-parent\n"
        if argv[0].endswith("/sftp-server"):
            return b"open\nclose\nread\nwrite\nstat\nfstat\nlstat\n"
        if argv[0].endswith("/systemctl"):
            return b"systemd 255 (255.4-1ubuntu8)\n"
        return b"fixture version 1.2.3\n"

    def probe(self):
        return stock.probe(self.root, uid=os.getuid(), gid=os.getgid(), provider={"uid": 4242, "gid": 4242},
                           command=self.command, load_library=lambda _: None, load_certificates=lambda _: True)

    def test_records_versions_libraries_and_absence_without_mutation(self):
        before = {str(path.relative_to(self.root)): (path.stat().st_mode, path.stat().st_mtime_ns,
                  path.read_bytes() if path.is_file() else None) for path in self.root.rglob("*")}
        result = self.probe()
        self.assertEqual(result["schema"], "zeros.stock-prerequisites/v1")
        self.assertEqual(set(result["packages"]), set(stock.PACKAGES))
        self.assertTrue(all(item["version"] == "1.2.3-1" for item in result["packages"].values()))
        self.assertEqual(result["apparmorCacheMode"], "skip-read-write")
        self.assertEqual(result["optionalSystemd"]["snapshot"]["absent"], "/usr/local/lib/systemd")
        after = {str(path.relative_to(self.root)): (path.stat().st_mode, path.stat().st_mtime_ns,
                 path.read_bytes() if path.is_file() else None) for path in self.root.rglob("*")}
        # Qualification can append only the fixed private observation. Every
        # original stock entry, including its timestamps, remains untouched.
        self.assertEqual(set(after) - set(before), {"run", "run/zeros", "run/zeros/diagnostic.lock",
                                                   "run/zeros/optional-systemd-observations.jsonl"})
        for name in set(after) - set(before):
            del after[name]
        self.assertEqual(before, after)
        log = self.root / "run/zeros/optional-systemd-observations.jsonl"
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(log.parent.stat().st_mode & 0o777, 0o700)
        rows = [json.loads(line) for line in log.read_bytes().splitlines()]
        self.assertEqual(rows, [{"schema": "zeros.optional-systemd-observation/v1", "callKind": "qualification",
                                 "outcome": "stable", "retryCount": 0, "terminalCheck": "none", "comparisons": []}])
        self.assertFalse(any("apt" in argv[0] or "ldconfig" in argv[0] or "fc-cache" in argv[0] for argv in self.calls))

    def test_stock_requirement_list_covers_remaining_capabilities_and_drops_unused_packages(self):
        required = {"bubblewrap", "apparmor", "git", "openssh-client", "openssh-sftp-server", "python3", "procps",
                    "util-linux", "curl", "ca-certificates", "socat", "unzip", "xz-utils", "busybox-static", "ripgrep",
                    "acl", "file", "make", "g++", "gnupg", "libnss3", "libgbm1", "libfontconfig1", "libfreetype6", "fonts-liberation"}
        self.assertTrue(required <= set(stock.PACKAGES))
        self.assertFalse({"podman", "crun", "slirp4netns", "uidmap", "inotify-tools", "xvfb", "git-lfs"} & set(stock.PACKAGES))
        self.assertTrue({"libX11.so.6", "libasound.so.2", "libnss3.so", "libgbm.so.1", "libfontconfig.so.1"}
                        <= {name for names in stock.LIBRARIES.values() for name in names})

    def test_each_missing_stock_package_fails_closed(self):
        for package in stock.PACKAGES:
            with self.subTest(package=package):
                self.missing_package = package
                with self.assertRaises(stock.Failure) as caught: self.probe()
                self.assertEqual(caught.exception.checks, ["base_compatibility"])

    def test_each_missing_binary_and_library_fails_closed(self):
        paths = list(stock.BINARIES) + ["/usr/lib/x86_64-linux-gnu/" + name
                                      for names in stock.LIBRARIES.values() for name in names]
        for path in paths:
            with self.subTest(path=path):
                target = self.root / path.lstrip("/")
                saved = target.read_bytes()
                mode = target.stat().st_mode & 0o7777
                target.unlink()
                try:
                    with self.assertRaises(stock.Failure): self.probe()
                finally: self.write(path, saved, mode)

    def test_apparmor_skip_cache_and_useradd_no_log_init_must_be_supported(self):
        self.unsupported_cache = True
        with self.assertRaises(stock.Failure): self.probe()
        self.unsupported_cache = False
        original = self.command
        self.command = lambda argv: b"usage\n" if argv[0].endswith("/useradd") else original(argv)
        with self.assertRaises(stock.Failure): self.probe()

    def test_busybox_must_be_static_and_native_libraries_loadable(self):
        busybox = self.root / "usr/bin/busybox"
        binary = bytearray(busybox.read_bytes())
        struct.pack_into("<I", binary, 64, 3)  # PT_INTERP
        busybox.write_bytes(binary)
        with self.assertRaises(stock.Failure): self.probe()
        struct.pack_into("<I", binary, 64, 1)
        busybox.write_bytes(binary)
        with self.assertRaises(stock.Failure):
            stock.probe(self.root, uid=os.getuid(), gid=os.getgid(), provider={"uid": 4242, "gid": 4242},
                        command=self.command, load_library=mock.Mock(side_effect=OSError("private-canary")),
                        load_certificates=lambda _: True)

    def test_ca_bundle_and_apparmor_kernel_support_are_required(self):
        self.write("/etc/ssl/certs/ca-certificates.crt", b"")
        with self.assertRaises(stock.Failure): self.probe()
        self.write("/etc/ssl/certs/ca-certificates.crt", b"fixture CA\n")
        self.write("/sys/module/apparmor/parameters/enabled", b"N\n")
        with self.assertRaises(stock.Failure): self.probe()


if __name__ == "__main__":
    unittest.main()
