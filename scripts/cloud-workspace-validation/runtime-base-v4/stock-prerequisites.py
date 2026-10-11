#!/usr/bin/python3 -IB
"""Read-only stock qualification. Never install packages or refresh caches."""
import sys
sys.dont_write_bytecode = True

import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import ssl
import stat
import struct
import subprocess
spec = importlib.util.spec_from_file_location("stock_bootstrap", Path(__file__).with_name("bootstrap.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
Failure, require = bootstrap.Failure, lambda condition: bootstrap.require(condition, "base_compatibility")

# Noble Chromium nativeDeps, plus the existing fontconfig/freetype consumers.
# Loading each SONAME also checks its transitive native dependencies.
LIBRARIES = {
    "libasound2t64": ("libasound.so.2",), "libatk-bridge2.0-0t64": ("libatk-bridge-2.0.so.0",),
    "libatk1.0-0t64": ("libatk-1.0.so.0",), "libatspi2.0-0t64": ("libatspi.so.0",),
    "libcairo2": ("libcairo.so.2",), "libcups2t64": ("libcups.so.2",), "libdbus-1-3": ("libdbus-1.so.3",),
    "libdrm2": ("libdrm.so.2",), "libgbm1": ("libgbm.so.1",),
    "libglib2.0-0t64": ("libglib-2.0.so.0", "libgobject-2.0.so.0", "libgio-2.0.so.0"),
    "libnspr4": ("libnspr4.so",), "libnss3": ("libnss3.so", "libnssutil3.so", "libsmime3.so"),
    "libpango-1.0-0": ("libpango-1.0.so.0",), "libx11-6": ("libX11.so.6",), "libxcb1": ("libxcb.so.1",),
    "libxcomposite1": ("libXcomposite.so.1",), "libxdamage1": ("libXdamage.so.1",), "libxext6": ("libXext.so.6",),
    "libxfixes3": ("libXfixes.so.3",), "libxkbcommon0": ("libxkbcommon.so.0",), "libxrandr2": ("libXrandr.so.2",),
    "libfontconfig1": ("libfontconfig.so.1",), "libfreetype6": ("libfreetype.so.6",),
}
PACKAGES = tuple(sorted({"acl", "apparmor", "bash", "bubblewrap", "busybox-static", "ca-certificates", "coreutils", "curl",
    "file", "fonts-liberation", "g++", "git", "gnupg", "gzip", "libc-bin", "libc6", "make", "openssh-client", "openssh-sftp-server", "passwd",
    "procps", "python3", "ripgrep", "socat", "sudo", "systemd", "tar", "unzip", "util-linux", "xz-utils", *LIBRARIES}))
VERSIONS = {
    "/usr/bin/bwrap": ("--version",), "/usr/sbin/apparmor_parser": ("--version",), "/usr/bin/git": ("--version",),
    "/usr/bin/ssh": ("-V",), "/usr/bin/python3": ("--version",), "/usr/bin/ps": ("--version",),
    "/usr/bin/flock": ("--version",), "/usr/bin/unshare": ("--version",), "/usr/bin/curl": ("--version",),
    "/usr/bin/socat": ("-V",), "/usr/bin/unzip": ("-v",), "/usr/bin/xz": ("--version",),
    "/usr/bin/busybox": ("--help",), "/usr/bin/rg": ("--version",), "/usr/bin/getfacl": ("--version",),
    "/usr/bin/setfacl": ("--version",), "/usr/bin/file": ("--version",), "/usr/bin/make": ("--version",),
    "/usr/bin/g++": ("--version",), "/usr/bin/gpg": ("--version",), "/usr/bin/systemctl": ("--version",),
}
BINARIES = tuple(sorted({*VERSIONS, "/usr/bin/sftp", "/usr/lib/openssh/sftp-server", "/usr/bin/ssh-keygen", "/usr/bin/aa-exec",
    "/usr/sbin/groupadd", "/usr/sbin/useradd", "/usr/sbin/usermod", "/usr/bin/systemd-run", "/usr/bin/systemd-tmpfiles",
    "/usr/bin/journalctl", "/usr/bin/dpkg-query", "/usr/bin/bash", "/usr/bin/sudo", "/usr/bin/env", "/usr/bin/install",
    "/usr/bin/chown", "/usr/bin/chmod", "/usr/bin/readlink", "/usr/bin/stat", "/usr/bin/mount", "/usr/bin/umount",
    "/usr/bin/setsid", "/usr/bin/pgrep", "/usr/bin/pkill", "/usr/bin/tar", "/usr/bin/gzip", "/usr/bin/ldd"}))


def command(argv):
    try:
        result = subprocess.run(argv, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False)
        require(result.returncode == 0 and len(result.stdout) + len(result.stderr) <= 128 * 1024)
        return result.stdout + result.stderr
    except (OSError, subprocess.TimeoutExpired):
        raise Failure("base_compatibility") from None


def file_record(app, absolute, executable=False):
    # Stock usr-merge/toolchain aliases are allowed only to a root-controlled
    # regular file. The optional /usr/local exception never applies here.
    target = app.path(absolute).resolve(strict=True)
    require(target.is_relative_to(app.root))
    resolved = "/" + str(target.relative_to(app.root))
    with app.directory(str(Path(resolved).parent)) as parent:
        fd = os.open(target.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == app.uid and info.st_gid == app.gid and
                    not info.st_mode & 0o022 and (not executable or info.st_mode & 0o111))
            digest = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b""): digest.update(block)
            return {"path": resolved, "sha256": digest.hexdigest()}


def static_busybox(path):
    with path.open("rb") as stream:
        header = stream.read(64)
        require(len(header) == 64 and header[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", header, 18)[0] == 62)
        offset, size, count = struct.unpack_from("<Q", header, 32)[0], struct.unpack_from("<H", header, 54)[0], struct.unpack_from("<H", header, 56)[0]
        require(64 <= offset <= 1024 * 1024 and 56 <= size <= 256 and 1 <= count <= 128)
        stream.seek(offset)
        headers = stream.read(size * count)
        require(len(headers) == size * count and all(struct.unpack_from("<I", headers, index * size)[0] != 3 for index in range(count)))


def certificates(path):
    return bool(ssl.create_default_context(cafile=str(path)).get_ca_certs())


def probe(root=Path("/"), *, uid=0, gid=0, provider=None, command=command, load_library=ctypes.CDLL, load_certificates=certificates):
    app = bootstrap.Bootstrap(root, uid=uid, gid=gid)
    try:
        raw = command([str(app.path("/usr/bin/dpkg-query")), "--show",
                       "--showformat=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n", *PACKAGES])
        packages = {}
        for line in raw.decode("ascii").splitlines():
            fields = line.split("\t")
            require(len(fields) == 4)
            name, version, arch, status = fields
            require(name in PACKAGES and name not in packages and status == "installed" and arch in ("amd64", "all") and
                    re.fullmatch(r"[A-Za-z0-9.+:~_-]{1,128}", version))
            packages[name] = {"version": version, "arch": arch}
        require(set(packages) == set(PACKAGES))
        binaries = {path: file_record(app, path, True) for path in BINARIES}
        for path, arguments in VERSIONS.items():
            require(command([str(app.path(path)), *arguments]).strip())
        parser_help = command([str(app.path("/usr/sbin/apparmor_parser")), "-K", "--help"])
        require(re.search(rb"-K\s*,\s*--skip-cache\b", parser_help))
        require(b"--no-log-init" in command([str(app.path("/usr/sbin/useradd")), "--help"]))
        bubblewrap = command([str(app.path("/usr/bin/bwrap")), "--help"])
        require(all(flag in bubblewrap for flag in (b"--ro-bind", b"--bind", b"--unshare-user", b"--unshare-ipc", b"--unshare-uts",
                                                   b"--unshare-pid", b"--unshare-cgroup", b"--proc", b"--dev", b"--tmpfs", b"--die-with-parent")))
        sftp = command([str(app.path("/usr/lib/openssh/sftp-server")), "-Q", "requests"]).splitlines()
        require({b"open", b"close", b"read", b"write", b"stat", b"fstat", b"lstat"} <= set(sftp))
        systemd = command([str(app.path("/usr/bin/systemctl")), "--version"])
        version = re.match(rb"systemd ([0-9]+)\b", systemd)
        require(version is not None and int(version[1]) >= 254)
        require(app.path("/sys/module/apparmor/parameters/enabled").read_text().strip() == "Y")
        static_busybox(app.path("/usr/bin/busybox"))
        ca_bundle = app.path("/etc/ssl/certs/ca-certificates.crt")
        require(ca_bundle.stat().st_size > 0 and load_certificates(ca_bundle))
        libraries = {}
        for names in LIBRARIES.values():
            for name in names:
                path = "/usr/lib/x86_64-linux-gnu/" + name
                libraries[name] = file_record(app, path)
                load_library(str(app.path(path)))
        if provider is None:
            account = pwd.getpwnam("user")
            provider = {"uid": account.pw_uid, "gid": account.pw_gid}
        return {"schema": "zeros.stock-prerequisites/v1", "packages": packages, "binaries": binaries, "libraries": libraries,
                "apparmorCacheMode": "skip-read-write", "optionalSystemd": app.qualify_optional_systemd(provider)}
    except (OSError, ValueError, KeyError, UnicodeError, struct.error):
        raise Failure("base_compatibility") from None


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 1 and os.geteuid() == 0)
        result = probe()
        print(json.dumps(result, sort_keys=True, separators=(",", ":")), flush=True)
    except BaseException:
        print(json.dumps({"schema": "zeros.diagnostic/v1", "component": "base", "stage": "build", "ok": False,
                          "exitCode": 1, "timedOut": False, "failedChecks": ["base_compatibility"]}), file=sys.stderr, flush=True)
        sys.exit(1)
