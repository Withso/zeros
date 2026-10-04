#!/usr/bin/python3
"""Base-owned v4 bootstrap. Python stdlib only; invoke with python3 -I.

No input, environment variable, archive member or runtime can select a command,
installation root, base policy, or cgroup. The injectable root/host/clock are for
rootless unit tests; the CLI always uses the physical host and root ownership.
"""
import base64
from collections import deque
import contextlib
import datetime
import errno
import fcntl
import gzip
import hashlib
import http.client
import io
import json
import os
import pwd
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse
import uuid

MAX_INPUT = 64 * 1024
MAX_SETUP_OUTPUT = 256 * 1024  # Existing Boat setup transport's stdout bound.
MAX_ARCHIVE = 2 * 1024**3
MAX_EXPANDED = 4 * 1024**3
MAX_MANIFEST = 64 * 1024**2
MAX_ENTRIES = 250_000
MAX_PATH_DEPTH = 128
MAX_LINK_COMPONENTS = 4096
# Leave readiness/verification time inside Boat exec's 600-second budget.
HYDRATION_TIMEOUT = 480
RESERVE = 512 * 1024**2
CHUNK = 1024 * 1024
HEX = re.compile(r"[0-9a-f]{64}\Z")
RID = re.compile(r"r1-[0-9a-f]{64}\Z")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8"}
INFRA = "/opt/zeros-infra"
FACADE = "/opt/zeros"
RECEIPTS = "/srv/zeros/runtime-installs"
ACTIVE = "/run/zeros/active-runtime.json"
PRIVATE_FAILURES = "/run/zeros/bootstrap-failures.jsonl"
PERSIST_ROOT = "/home/user/.zeros-persist"
PERSIST_RECORD = "/run/zeros/persistence.json"
PERSIST_RESIDUE = "/run/zeros/persistence-residue.json"
# Only fixed paths are mounted. Mutable contents retain the existing runtime
# ownership contract; root controls the backing parent and every mount point.
PERSIST_LAYOUT = (("files", "root", "root", 0o755), ("state", "engine", "engine", 0o700),
                  ("home", "root", "root", 0o755),
                  ("repos", "root", "root", 0o755))
FACADE_LINKS = (("/zeros", FACADE), (FACADE + "/bin", "current/bin"),
                (FACADE + "/worker", "current/worker"), (FACADE + "/manifest.json", "current/manifest.json"),
                (FACADE + "/logs", "/srv/zeros/log"), (FACADE + "/state", "/srv/zeros/state"))
CGROUP = "/sys/fs/cgroup/system.slice/zeros-host.service"
HOST_LIMITS = (("cpu.max", "100000 100000"), ("memory.max", str(512 * 1024**2)),
               ("pids.max", "256"), ("memory.oom.group", "1"))
ENTRYPOINTS = {"node": "bin/node", "setup": "lib/zeros/setup-cloud-workspace.mjs",
               "startEngine": "bin/start-engine.sh", "supervisor": "lib/zeros/cloud-worker-supervisor.mjs",
               "selfTest": "lib/zeros/runtime-self-test.mjs"}
STAGES = ("validate_input", "lock", "check_space", "check_cache", "download", "verify_archive",
          "verify_manifest", "extract", "verify_tree", "publish_receipt", "switch_pointer",
          "start_host", "run_setup", "done")
INSTALLER_CHECKS = frozenset(("input_schema", "input_too_large", "artifact_host", "artifact_expired",
    "insufficient_space", "cache_conflict", "http_status", "download_truncated", "archive_digest",
    "archive_size", "manifest_digest", "manifest_schema", "bootstrap_protocol", "archive_paths",
    "archive_member_type", "file_inventory", "file_digest", "file_mode", "symlink_escape",
    "root_ownership", "hard_link", "pointer_publish", "host_start", "setup_exit", "timeout",
    "process_signal", "diagnostic_missing", "lock_busy", "base_compatibility", "cgroup_retired"))
CHECKS = INSTALLER_CHECKS | frozenset(("uid_map", "apparmor", "cgroup_controllers"))
PERMANENT_DISPATCH_CHECKS = frozenset(("base_compatibility", "bootstrap_protocol", "manifest_digest", "manifest_schema",
    "archive_paths", "file_inventory", "file_digest", "file_mode", "symlink_escape", "root_ownership", "hard_link",
    "cache_conflict", "pointer_publish", "cgroup_controllers"))
STAGE_CHECK = dict(zip(STAGES, ("input_schema", "lock_busy", "insufficient_space", "cache_conflict",
    "http_status", "archive_digest", "manifest_schema", "archive_paths", "file_inventory",
    "cache_conflict", "pointer_publish", "host_start", "setup_exit", "diagnostic_missing")))


def failure_site(frame, line):
    name = os.path.basename(frame.f_code.co_filename)
    source = {"bootstrap.py": "bootstrap", "verify.py": "verify", "sanitize.py": "sanitize", "<stdin>": "probe"}.get(name)
    if source:
        function = frame.f_code.co_name
        return {"source": source, "function": function if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,80}", function) else "anonymous",
                "line": line}


def failure_sites(frame):
    """Source locations only: never frame locals, source text or input paths."""
    sites = []
    while frame is not None and len(sites) < 12:
        site = failure_site(frame, frame.f_lineno)
        if site:
            sites.append(site)
        frame = frame.f_back
    return sites


def exception_sites(error):
    # Traceback line numbers preserve the raising site even after the caller
    # reaches its exception handler. Unrelated library frames are excluded.
    sites = deque(maxlen=12)
    trace = error.__traceback__
    while trace is not None:
        site = failure_site(trace.tb_frame, trace.tb_lineno)
        # Report the enclosing named function for compiler-generated
        # comprehensions; their anonymous names hide the useful call site.
        if site and trace.tb_frame.f_code.co_name not in ("<genexpr>", "<listcomp>", "<dictcomp>", "<setcomp>"):
            sites.appendleft(site)
        trace = trace.tb_next
    return list(sites)


class Failure(Exception):
    def __init__(self, check, code=1, checks=(), timed_out=False):
        self.checks = list(dict.fromkeys([check, *checks]))[:32]
        if any(c not in CHECKS for c in self.checks):
            self.checks = ["diagnostic_missing"]
        self.code = code
        self.timed_out = timed_out
        self.sites = failure_sites(sys._getframe(1))
        super().__init__(self.checks[0])


def require(ok, check):
    if not ok:
        raise Failure(check)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def packed(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()


def strict_json(raw, check):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key.isascii() and key not in result, check)
            result[key] = value
        return result
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Failure(check)))
    except (ValueError, UnicodeError, RecursionError):
        raise Failure(check) from None


def shape(value, required, optional=(), check="input_schema"):
    require(type(value) is dict and set(required) <= value.keys() and
            value.keys() <= set(required) | set(optional), check)


def integer(value, low, high, check):
    require(type(value) is int and low <= value <= high, check)


def text_match(value, pattern, check):
    require(type(value) is str and re.fullmatch(pattern, value) is not None, check)


def timestamp(value, check):
    text_match(value, r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)", check)
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise Failure(check) from None


def safe_path(path, check="archive_paths"):
    require(type(path) is str and re.search(r"[\0\\\r\n\ud800-\udfff]", path) is None and
            0 < len(path.encode("utf-8")) <= 4096 and len(path.split("/")) <= MAX_PATH_DEPTH and
            all(part not in ("", ".", "..") for part in path.split("/")), check)
    return path


def mode_number(mode, check="file_mode"):
    text_match(mode, r"0[0-7]{3}", check)
    result = int(mode, 8)
    require(not result & 0o022, check)
    return result


def validate_descriptor(value):
    shape(value, ("runtimeId", "manifestSha256", "archiveSha256", "archiveBytes", "expandedBytes",
                  "sourceCommit", "nodeModulesAbi", "bootstrapProtocolVersion", "engineProtocolVersion"))
    for key in ("manifestSha256", "archiveSha256"):
        text_match(value[key], HEX, "input_schema")
    require(value["runtimeId"] == "r1-" + value["manifestSha256"], "input_schema")
    text_match(value["sourceCommit"], r"[a-f0-9]{40}", "input_schema")
    integer(value["archiveBytes"], 1, MAX_ARCHIVE, "input_schema")
    integer(value["expandedBytes"], 1, MAX_EXPANDED, "input_schema")
    integer(value["nodeModulesAbi"], 1, 65535, "input_schema")
    integer(value["engineProtocolVersion"], 1, 65535, "input_schema")
    integer(value["bootstrapProtocolVersion"], 1, 1, "bootstrap_protocol")
    return value


def validate_input(raw, compat, now):
    require(len(raw) <= MAX_INPUT, "input_too_large")
    # A transport newline is allowed; embedded whitespace and padding are not.
    raw = raw.removesuffix(b"\n")
    require(re.fullmatch(rb"[A-Za-z0-9_-]+", raw) is not None and len(raw) % 4 != 1, "input_schema")
    try:
        decoded = base64.b64decode(raw + b"=" * (-len(raw) % 4), altchars=b"-_", validate=True)
    except ValueError:
        raise Failure("input_schema") from None
    require(base64.urlsafe_b64encode(decoded).rstrip(b"=") == raw, "input_schema")
    value = strict_json(decoded, "input_schema")
    shape(value, ("schema", "purpose", "runtime", "artifact"), ("setup",))
    require(value["schema"] == "zeros.runtime-install/v1" and
            value["purpose"] in ("workspace-setup", "build", "qualification"), "input_schema")
    validate_descriptor(value["runtime"])
    if value["purpose"] == "workspace-setup":
        setup = value.get("setup")
        text_match(setup, r"[A-Za-z0-9_-]{1,49152}", "input_schema")
        require(len(setup) % 4 != 1, "input_schema")
    else:
        require("setup" not in value, "input_schema")
    artifact = value["artifact"]
    shape(artifact, ("url", "expiresAt"))
    require(type(artifact["url"]) is str and len(artifact["url"]) <= 8192 and
            all(ord(c) > 32 and ord(c) < 127 for c in artifact["url"]) and "\\" not in artifact["url"], "artifact_host")
    try:
        parsed = urllib.parse.urlsplit(artifact["url"])
        host = parsed.hostname or ""
        require(parsed.scheme == "https" and parsed.port in (None, 443) and
                not parsed.username and not parsed.password and not parsed.fragment and
                re.fullmatch(r"[a-z0-9.-]+", host) is not None and
                any(host.endswith(suffix) and len(host) > len(suffix) for suffix in compat["artifactHostSuffixes"]), "artifact_host")
    except ValueError:
        raise Failure("artifact_host") from None
    remaining = (timestamp(artifact["expiresAt"], "artifact_expired") - now).total_seconds()
    require(0 < remaining <= 900, "artifact_expired")
    return value


def validate_links(files):
    inventory = {entry["path"]: entry for entry in files}
    links = {}
    for entry in files:
        if entry["type"] != "symlink":
            continue
        target = entry["target"]
        require(type(target) is str and re.search(r"[\0\\\r\n\ud800-\udfff]", target) is None and
                0 < len(target.encode("utf-8")) <= 4096 and not target.startswith("/"), "symlink_escape")
        parts = target.split("/")
        depth = len(entry["path"].split("/")) - 1
        # Lexical containment is independent of resolution through other
        # inventory links. A deep alias cannot make a lexical escape valid.
        for part in parts:
            if part == "..":
                require(depth > 0, "symlink_escape")
                depth -= 1
            elif part not in ("", "."):
                depth += 1
        links[entry["path"]] = parts
    for name, parts in links.items():
        pending = deque(name.split("/")[:-1] + parts)
        components = len(pending)
        require(components <= MAX_LINK_COMPONENTS, "symlink_escape")
        resolved, resolving = [], {name}
        steps = 1  # Include the link whose target we are resolving.
        while pending:
            part = pending.popleft()
            if isinstance(part, tuple):
                resolving.remove(part[0])
                continue
            components -= 1
            if part in ("", "."):
                continue
            if part == "..":
                require(bool(resolved), "symlink_escape")
                resolved.pop()
                continue
            candidate = "/".join([*resolved, part])
            item = inventory.get(candidate)
            require(item is not None, "symlink_escape")
            if item["type"] == "symlink":
                require(candidate not in resolving and steps < 64, "symlink_escape")
                resolving.add(candidate)
                steps += 1
                link = links[candidate]
                components += len(link)
                require(components <= MAX_LINK_COMPONENTS, "symlink_escape")
                # A marker retires only this expansion. Store link identities,
                # never copies of the growing unresolved suffix.
                pending.appendleft((candidate,))
                pending.extendleft(reversed(link))
            else:
                require(not components or item["type"] == "dir", "symlink_escape")
                resolved.append(part)


def validate_manifest(raw, descriptor, compat):
    require(len(raw) <= MAX_MANIFEST, "manifest_schema")
    require(sha(raw) == descriptor["manifestSha256"], "manifest_digest")
    value = strict_json(raw, "manifest_schema")
    shape(value, ("agents", "entrypoints", "files", "platform", "protocols", "schema", "source"), check="manifest_schema")
    require(value["schema"] in compat["supportedManifestSchemas"] and value["schema"] == "zeros.runtime-manifest/v1", "manifest_schema")
    entrypoints = value["entrypoints"]
    shape(entrypoints, ("node", "setup", "startEngine", "supervisor"), ("selfTest",), check="manifest_schema")
    require(all(target == ENTRYPOINTS[name] for name, target in entrypoints.items()), "manifest_schema")
    shape(value["agents"], ("claude", "codex", "cursor"), check="manifest_schema")
    for agent, fields in (("claude", ("cli", "sdk")), ("codex", ("package",)), ("cursor", ("sdk",))):
        shape(value["agents"][agent], fields, check="manifest_schema")
        for version in value["agents"][agent].values():
            text_match(version, r"[0-9A-Za-z][0-9A-Za-z.-]{0,63}", "manifest_schema")
    platform = value["platform"]
    shape(platform, ("arch", "libc", "minGlibc", "node", "nodeModulesAbi", "os"), check="manifest_schema")
    require(platform["arch"] == "x64" and platform["libc"] == "glibc" and platform["os"] == "linux" and
            platform["node"] == "22.23.1" and type(platform["nodeModulesAbi"]) is int and
            platform["nodeModulesAbi"] == descriptor["nodeModulesAbi"] == 127, "manifest_schema")
    text_match(platform["minGlibc"], r"[0-9]+\.[0-9]+", "manifest_schema")
    require(tuple(map(int, platform["minGlibc"].split("."))) <= tuple(map(int, compat["glibc"].split("."))), "base_compatibility")
    protocols = value["protocols"]
    shape(protocols, ("bootstrap", "engine", "setup"), check="manifest_schema")
    integer(protocols["bootstrap"], 1, 1, "bootstrap_protocol")
    integer(protocols["setup"], 2, 2, "bootstrap_protocol")
    require(type(protocols["engine"]) is int and protocols["engine"] == descriptor["engineProtocolVersion"], "manifest_schema")
    source = value["source"]
    shape(source, ("commit", "lockfileSha256"), check="manifest_schema")
    require(source["commit"] == descriptor["sourceCommit"], "manifest_schema")
    text_match(source["lockfileSha256"], HEX, "manifest_schema")
    files = value["files"]
    require(type(files) is list and 0 < len(files) <= MAX_ENTRIES, "file_inventory")
    inventory, last, expanded = {}, b"", 0
    for entry in files:
        require(type(entry) is dict, "manifest_schema")
        kind = entry.get("type")
        fields = {"file": ("type", "path", "mode", "size", "sha256"), "dir": ("type", "path", "mode"),
                  "symlink": ("type", "path", "target")}
        require(type(kind) is str and kind in fields, "manifest_schema")
        shape(entry, fields[kind], check="manifest_schema")
        name = safe_path(entry["path"])
        require(name != "manifest.json" and name.encode() > last, "file_inventory")
        last = name.encode()
        parent = name.rpartition("/")[0]
        require(not parent or inventory.get(parent, {}).get("type") == "dir", "archive_paths")
        if kind != "symlink":
            mode_number(entry["mode"])
        if kind == "file":
            integer(entry["size"], 0, MAX_EXPANDED, "file_inventory")
            text_match(entry["sha256"], HEX, "manifest_schema")
            expanded += entry["size"]
        inventory[name] = entry
    require(expanded == descriptor["expandedBytes"] and 1 <= expanded <= MAX_EXPANDED, "file_inventory")
    for name in entrypoints.values():
        require(inventory.get(name, {}).get("type") == "file", "file_inventory")
    require(int(inventory["bin/node"]["mode"], 8) & 0o100, "file_mode")
    validate_links(files)
    return value


def download_https(artifact, stream, descriptor):
    """No proxies, credentials, redirects, decompression or URL-bearing errors."""
    parsed = urllib.parse.urlsplit(artifact["url"])
    connection = http.client.HTTPSConnection(parsed.hostname, port=443, timeout=30)
    deadline = time.monotonic() + 600
    try:
        connection.request("GET", urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, "")),
                           headers={"Accept-Encoding": "identity"})
        response = connection.getresponse()
        require(response.status == 200 and response.getheader("Content-Encoding") in (None, "identity"), "http_status")
        length = response.getheader("Content-Length")
        if length is not None:
            require(length.isascii() and length.isdecimal() and int(length) == descriptor["archiveBytes"], "archive_size")
        count = 0
        while True:
            if time.monotonic() >= deadline:
                raise Failure("timeout", code=124, timed_out=True)
            data = response.read(min(CHUNK, descriptor["archiveBytes"] + 1 - count))
            if not data:
                break
            count += len(data)
            require(count <= descriptor["archiveBytes"], "archive_size")
            stream.write(data)
        require(count == descriptor["archiveBytes"], "download_truncated")
    except TimeoutError:
        raise Failure("timeout", code=124, timed_out=True) from None
    except (OSError, http.client.HTTPException):
        raise Failure("download_truncated") from None
    finally:
        connection.close()


def read_exact(stream, size):
    data = stream.read(size)
    require(len(data) == size, "archive_size")
    return data


def consume(stream, size, output=None):
    digest = hashlib.sha256()
    while size:
        part = read_exact(stream, min(size, CHUNK))
        digest.update(part)
        if output is not None:
            output.write(part)
        size -= len(part)
    return digest.hexdigest()


def pax_records(raw):
    fields = {}
    while raw:
        split = raw.find(b" ")
        require(0 < split < 10 and raw[:split].isdigit(), "archive_member_type")
        size = int(raw[:split])
        require(split + 3 < size <= len(raw) and raw[size - 1:size] == b"\n", "archive_member_type")
        pair = raw[split + 1:size - 1].split(b"=", 1)
        require(len(pair) == 2 and pair[0] in (b"path", b"linkpath"), "archive_member_type")
        key = pair[0].decode("ascii")
        require(key not in fields, "archive_member_type")
        fields[key] = pair[1].decode("utf-8", "strict")
        raw = raw[size:]
    return fields


def archive_members(file):
    """Read raw headers so tarfile cannot hide global/PAX/GNU metadata.

    The caller must consume exactly member.size bytes before advancing. Never
    call tarfile.extract(all); every write is through a no-follow directory FD.
    """
    with open(file, "rb") as source:
        header = source.read(10)
        require(len(header) == 10 and header[:4] == b"\x1f\x8b\x08\x00" and header[4:8] == b"\0" * 4,
                "archive_member_type")
        source.seek(0)
        with gzip.GzipFile(fileobj=source) as stream:
            pax, count = None, 0
            while True:
                block = read_exact(stream, 512)
                if block == b"\0" * 512:
                    require(pax is None and read_exact(stream, 512) == block, "archive_member_type")
                    tail = stream.read(10241)
                    require(len(tail) <= 10240 and not tail.strip(b"\0"), "archive_member_type")
                    return
                require(count <= MAX_ENTRIES and stream.tell() <= MAX_EXPANDED + MAX_MANIFEST + MAX_ENTRIES * 2048,
                        "archive_size")
                require(block[257:265] == b"ustar\x0000", "archive_member_type")
                for start, end in ((0, 100), (157, 257), (265, 297), (297, 329), (345, 500)):
                    field = block[start:end]
                    if b"\0" in field:
                        require(not field[field.index(0):].strip(b"\0"), "archive_paths")
                try:
                    info = tarfile.TarInfo.frombuf(block, "utf-8", "strict")
                except (tarfile.TarError, ValueError):
                    raise Failure("archive_member_type") from None
                require(info.uid == 0 and info.gid == 0 and not info.uname and not info.gname, "root_ownership")
                require(info.mtime == 0 and info.devmajor == 0 and info.devminor == 0, "archive_member_type")
                require(info.issym() or not info.mode & 0o7000, "file_mode")
                if info.type == tarfile.XHDTYPE:
                    require(count > 0 and pax is None and 0 < info.size <= 16384, "archive_member_type")
                    pax = pax_records(read_exact(stream, info.size))
                    require(not read_exact(stream, -info.size % 512).strip(b"\0"), "archive_member_type")
                    continue
                require(info.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE), "archive_member_type")
                if pax:
                    info.name = pax.get("path", info.name)
                    info.linkname = pax.get("linkpath", info.linkname)
                    require("linkpath" not in pax or info.issym(), "archive_member_type")
                pax = None
                if info.isdir():
                    info.name = info.name.removesuffix("/")
                safe_path(info.name)
                require(0 <= info.size <= MAX_EXPANDED and (info.isfile() or info.size == 0), "archive_size")
                require(info.issym() or not info.linkname, "archive_member_type")
                offset = stream.tell()
                yield info, stream
                require(stream.tell() == offset + info.size, "archive_size")
                require(not read_exact(stream, -info.size % 512).strip(b"\0"), "archive_member_type")
                count += 1


def parse_mountinfo(raw):
    require(len(raw) <= 2 * 1024**2, "base_compatibility")
    def pathname(value):
        escapes = {"040": " ", "011": "\t", "012": "\n", "134": "\\"}
        value = re.sub(r"\\(040|011|012|134)", lambda match: escapes[match[1]], value)
        require(value.startswith("/") and os.path.normpath(value) == value, "base_compatibility")
        return value
    result = []
    for line in raw.decode("utf-8", "strict").splitlines():
        fields = line.split()
        require(len(fields) >= 10 and "-" in fields[6:], "base_compatibility")
        separator = fields.index("-", 6)
        require(len(fields) == separator + 4 and re.fullmatch(r"[0-9]+:[0-9]+", fields[2]), "base_compatibility")
        require(fields[0].isdigit(), "base_compatibility")
        result.append({"id": int(fields[0]), "device": fields[2], "root": pathname(fields[3]), "target": pathname(fields[4]),
                       "options": fields[5].split(","), "filesystem": fields[separator + 1], "source": fields[separator + 2]})
    require(result, "base_compatibility")
    return result


class BindMounts:
    """Kernel mounts are separate from systemd so temporary roots can inject them."""
    def table(self):
        with open("/proc/self/mountinfo", "rb") as stream:
            return parse_mountinfo(stream.read(2 * 1024**2 + 1))

    def present(self, target):
        matches = [entry for entry in self.table() if entry["target"] == str(target)]
        require(len(matches) <= 1, "base_compatibility")
        return bool(matches)

    def unmounted(self, target):
        require(not any(entry["target"] == str(target) or entry["target"].startswith(str(target) + "/")
                        for entry in self.table()), "base_compatibility")

    def mount_id(self, fd):
        # st_dev cannot distinguish a bind of the same filesystem. Check the
        # opened inode's actual mount, including mounts added after table().
        with open(f"/proc/self/fdinfo/{fd}", "rb") as stream:
            raw = stream.read(4097)
        matches = re.findall(rb"^mnt_id:\s*([0-9]+)$", raw, re.MULTILINE)
        require(len(raw) <= 4096 and len(matches) == 1, "base_compatibility")
        return int(matches[0])

    def bind(self, source_fd, target_fd):
        # Pass pinned directory descriptors, never re-resolve a user-owned
        # ancestor in mount(8). The destination is reopened after mounting.
        # Refuse a FUSE or detached fd even if hydration's marker/table changed
        # between the readiness gate and opening the source directory.
        source_mount = self.mount_id(source_fd)
        matches = [entry for entry in self.table() if entry["id"] == source_mount]
        require(len(matches) == 1 and not matches[0]["filesystem"].startswith("fuse"), "base_compatibility")
        try:
            result = subprocess.run(["/usr/bin/mount", "--bind", "--no-canonicalize",
                                     f"/proc/self/fd/{source_fd}", f"/proc/self/fd/{target_fd}"],
                                    pass_fds=(source_fd, target_fd), env=ENV, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
        except subprocess.TimeoutExpired:
            raise Failure("timeout", code=124, timed_out=True) from None
        require(result.returncode == 0, "base_compatibility")

    def verify(self, source, target, source_fd, target_fd):
        source, target = str(source), str(target)
        table = self.table()
        # Backing children must not themselves be aliases of storage elsewhere.
        backing = source.rsplit("/", 1)[0]
        require(not any(entry["target"] == backing or entry["target"].startswith(backing + "/") for entry in table),
                "base_compatibility")
        parents = [entry for entry in table if entry["target"] == "/" or source == entry["target"] or source.startswith(entry["target"] + "/")]
        require(parents, "base_compatibility")
        longest = max(len(entry["target"]) for entry in parents)
        parents = [entry for entry in parents if len(entry["target"]) == longest]
        mounts = [entry for entry in table if entry["target"] == target]
        require(len(parents) == len(mounts) == 1 and
                not any(entry["target"].startswith(target + "/") for entry in table), "base_compatibility")
        parent, mounted = parents[0], mounts[0]
        require(not parent["filesystem"].startswith("fuse") and not mounted["filesystem"].startswith("fuse"), "base_compatibility")
        expected_root = os.path.normpath(os.path.join(parent["root"], os.path.relpath(source, parent["target"])))
        src, dst = os.fstat(source_fd), os.fstat(target_fd)
        require((src.st_dev, src.st_ino) == (dst.st_dev, dst.st_ino) and
                parent["device"] == mounted["device"] == f"{os.major(src.st_dev)}:{os.minor(src.st_dev)}" and
                parent["filesystem"] == mounted["filesystem"] and parent["source"] == mounted["source"] and
                mounted["root"] == expected_root and "rw" in mounted["options"], "base_compatibility")
        return {"device": src.st_dev, "inode": src.st_ino}


class Bootstrap:
    def __init__(self, root=Path("/"), *, uid=0, gid=0, host=None, now=None, boot_id=None, downloader=download_https):
        self.root = Path(root)
        self.uid, self.gid = uid, gid
        self.host = host if host is not None else SystemHost()
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self.boot_id = boot_id or (lambda: Path("/proc/sys/kernel/random/boot_id").read_text().strip())
        self.downloader = downloader
        self.fault = lambda _: None
        self.stage = "validate_input"
        self.compat = None
        self.compat_id = None
        self.mounts = BindMounts()
        self.accounts = {"agent": (10001, 10001), "capture": (10002, 10002), "engine": (10003, 10003)}

    def path(self, absolute):
        require(absolute.startswith("/") and ".." not in absolute.split("/"), "archive_paths")
        return self.root / absolute.lstrip("/")

    def owner(self, st):
        require(st.st_uid == self.uid and st.st_gid == self.gid, "root_ownership")
        require(not st.st_mode & 0o022, "file_mode")

    @contextlib.contextmanager
    def directory(self, absolute, create=False, mode=0o755):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            self.owner(os.fstat(fd))
            parts = absolute.strip("/").split("/") if absolute != "/" else []
            for index, part in enumerate(parts):
                require(part not in ("", ".", ".."), "archive_paths")
                created = False
                requested_mode = mode if index == len(parts) - 1 else 0o755
                if create:
                    try:
                        os.mkdir(part, requested_mode, dir_fd=fd)
                        created = True
                        os.fsync(fd)
                    except FileExistsError:
                        pass
                try:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                except OSError:
                    raise Failure("root_ownership") from None
                os.close(fd)
                fd = child
                if created:
                    os.fchmod(fd, requested_mode)
                    os.fsync(fd)
                self.owner(os.fstat(fd))
            yield fd
        finally:
            os.close(fd)

    def read(self, absolute, limit, mode=None):
        parent, name = absolute.rsplit("/", 1)
        with self.directory(parent or "/") as directory:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
            with os.fdopen(fd, "rb") as stream:
                st = os.fstat(stream.fileno())
                self.check_stat(st, {"type": "file", "mode": f"{mode:04o}" if mode is not None else f"{stat.S_IMODE(st.st_mode):04o}", "size": st.st_size})
                require(st.st_size <= limit, "file_inventory")
                data = stream.read(limit + 1)
                require(len(data) <= limit, "file_inventory")
                return data

    def atomic(self, absolute, data, mode=0o600):
        parent, name = absolute.rsplit("/", 1)
        with self.directory(parent) as directory:
            temporary = ".tmp-" + uuid.uuid4().hex
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=directory)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fchmod(stream.fileno(), mode)
                    os.fsync(stream.fileno())
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass

    def log_failure(self, error, stage=None):
        """Bounded root-only assertion evidence; the public diagnostic is unchanged."""
        try:
            cause = error.__cause__ if isinstance(error, Failure) and error.__cause__ is not None else error
            name = type(cause).__name__
            allowed = {"Failure", "OSError", "FileNotFoundError", "PermissionError", "TimeoutError", "ValueError",
                       "TypeError", "KeyError", "AssertionError", "RuntimeError", "NotADirectoryError", "IsADirectoryError",
                       "FileExistsError", "BlockingIOError", "InterruptedError", "BrokenPipeError"}
            sites = cause.sites if isinstance(cause, Failure) else exception_sites(cause)
            value = {"schema": "zeros.bootstrap-private-failure/v1", "stage": stage or self.stage,
                     "error": name if name in allowed else "Exception", "sites": sites,
                     "failedChecks": error.checks if isinstance(error, Failure) else ["diagnostic_missing"]}
            if isinstance(cause, OSError) and type(cause.errno) is int and cause.errno in errno.errorcode:
                value["errno"] = {"name": errno.errorcode[cause.errno], "number": cause.errno}
            require(value["stage"] in (*STAGES, "verify", "sanitize", "resume"), "diagnostic_missing")
            with self.directory("/run/zeros", create=True, mode=0o700) as directory:
                require(stat.S_IMODE(os.fstat(directory).st_mode) == 0o700, "file_mode")
            with self.lock("diagnostic.lock"):
                try:
                    previous = self.read(PRIVATE_FAILURES, 65536, 0o600)
                except FileNotFoundError:
                    previous = b""
                line = packed(value) + b"\n"
                if len(previous) + len(line) > 65536:
                    previous = previous[-32768:].partition(b"\n")[2]
                self.atomic(PRIVATE_FAILURES, previous + line)
            return True
        except (OSError, Failure, ValueError):
            # Evidence must not mask the original failure or prevent cleanup.
            return False

    def unlink(self, absolute):
        parent, name = absolute.rsplit("/", 1)
        with self.directory(parent) as directory:
            try:
                os.unlink(name, dir_fd=directory)
                os.fsync(directory)
            except FileNotFoundError:
                pass

    def link(self, name, target, replace=False):
        parent, leaf = name.rsplit("/", 1)
        with self.directory(parent or "/") as directory:
            try:
                st = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
                require(stat.S_ISLNK(st.st_mode) and st.st_uid == self.uid and st.st_gid == self.gid, "pointer_publish")
                if not replace:
                    require(os.readlink(leaf, dir_fd=directory) == target, "pointer_publish")
                    return
            except FileNotFoundError:
                pass
            temp = ".link-" + uuid.uuid4().hex
            try:
                os.symlink(target, temp, dir_fd=directory)
                os.replace(temp, leaf, src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                try:
                    os.unlink(temp, dir_fd=directory)
                except FileNotFoundError:
                    pass

    @contextlib.contextmanager
    def lock(self, name):
        with self.directory("/run/zeros") as directory:
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            try:
                self.check_stat(os.fstat(fd), {"type": "file", "size": 0, "mode": "0600"})
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise Failure("lock_busy") from None
                yield
            finally:
                os.close(fd)

    def base(self):
        raw = self.read("/opt/zeros-bootstrap/compatibility.json", 256 * 1024, 0o444)
        value = strict_json(raw, "base_compatibility")
        shape(value, ("arch", "artifactHostSuffixes", "bootstrapProtocolVersion", "glibc", "os", "protectedFiles",
                      "schema", "supportedManifestSchemas", "systemdMin", "uids"), check="base_compatibility")
        require(value["schema"] == "zeros.base-compatibility/v1" and value["arch"] == "x64" and
                value["os"] == {"id": "ubuntu", "versionId": "24.04"} and value["glibc"] == "2.39" and
                value["uids"] == {"agent": 10001, "capture": 10002, "engine": 10003, "coordinator": 10004} and
                value["supportedManifestSchemas"] == ["zeros.runtime-manifest/v1"], "base_compatibility")
        integer(value["bootstrapProtocolVersion"], 1, 1, "bootstrap_protocol")
        integer(value["systemdMin"], 254, 254, "base_compatibility")
        suffixes = value["artifactHostSuffixes"]
        require(type(suffixes) is list and 1 <= len(suffixes) <= 16, "base_compatibility")
        for suffix in suffixes:
            text_match(suffix, r"\.[a-z0-9-]+(?:\.[a-z0-9-]+)+", "base_compatibility")
        files = value["protectedFiles"]
        require(type(files) is list and 1 <= len(files) <= 128, "base_compatibility")
        seen = set()
        for entry in files:
            shape(entry, ("mode", "path", "sha256"), check="base_compatibility")
            target = entry["path"]
            require(type(target) is str and target.startswith("/") and target != "/opt/zeros-bootstrap/compatibility.json" and
                    target not in seen, "base_compatibility")
            safe_path(target[1:], "base_compatibility")
            seen.add(target)
            text_match(entry["sha256"], HEX, "base_compatibility")
            require(sha(self.read(target, 2 * 1024 * 1024, mode_number(entry["mode"]))) == entry["sha256"], "base_compatibility")
        self.compat, self.compat_id = value, "bc1-" + sha(raw)

    def layout(self):
        for absolute, mode in (("/opt/zeros", 0o755), (INFRA, 0o755), (INFRA + "/.staging", 0o700),
                               (RECEIPTS, 0o700), ("/opt/zeros/sessions", 0o700), ("/run/zeros", 0o700)):
            with self.directory(absolute, create=True, mode=mode) as fd:
                require(stat.S_IMODE(os.fstat(fd).st_mode) == mode, "file_mode")
        for name, target in FACADE_LINKS:
            self.link(name, target)

    def account(self, name):
        if name == "root":
            return self.uid, self.gid
        if name == "user" and name not in self.accounts:
            provider = pwd.getpwnam("user")
            return provider.pw_uid, provider.pw_gid
        return self.accounts[name]

    @contextlib.contextmanager
    def data_directory(self, parent, name, uid, gid, mode, create=False, exact=True):
        require(name and "/" not in name and name not in (".", ".."), "base_compatibility")
        created = False
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
                created = True
            except FileExistsError:
                pass
        try:
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except OSError as error:
            raise Failure("root_ownership") from error
        try:
            if created:
                self.owner(os.fstat(fd))
                os.fchown(fd, uid, gid)
                os.fchmod(fd, mode)
                os.fsync(fd)
                os.fsync(parent)
            st = os.fstat(fd)
            require((st.st_uid, st.st_gid) == (uid, gid), "root_ownership")
            require(stat.S_IMODE(st.st_mode) == mode if exact else not st.st_mode & 0o022, "file_mode")
            yield fd
        finally:
            os.close(fd)

    def machine_id(self, create=False):
        try:
            raw = self.read("/etc/machine-id", 33)
        except FileNotFoundError:
            require(create, "base_compatibility")
            raw = b""
        if not raw and create:
            raw = (uuid.uuid4().hex + "\n").encode()
            self.atomic("/etc/machine-id", raw, 0o444)
        require(re.fullmatch(rb"[0-9a-f]{32}\n?", raw) is not None and raw.strip() != b"0" * 32, "base_compatibility")
        return sha(raw)

    def clear_persistence_residue(self, target, root_fd):
        """Delete only uncovered capture residue; the backing tree is authority."""
        self.mounts.unmounted(target)  # Refuse nested mounts before any deletion.
        mount_id = self.mounts.mount_id(root_fd)
        counts = dict.fromkeys(("directories", "files", "symlinks", "other"), 0)

        @contextlib.contextmanager
        def directory(parts):
            fd = os.dup(root_fd)
            try:
                for part in parts:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                    os.close(fd)
                    fd = child
                    require(self.mounts.mount_id(fd) == mount_id, "base_compatibility")
                yield fd
            finally:
                os.close(fd)

        # Iterative postorder with a constant descriptor count, even for deep
        # residue left by an older base. Every component is reopened no-follow
        # relative to the pinned root; never use resolved user paths.
        pending = [((name,), False) for name in os.listdir(root_fd)]
        while pending:
            parts, visited = pending.pop()
            with directory(parts[:-1]) as parent:
                info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    with directory(parts) as child:
                        opened = os.fstat(child)
                        require((info.st_dev, info.st_ino) == (opened.st_dev, opened.st_ino), "base_compatibility")
                        if not visited:
                            os.fchmod(child, 0o700)
                            pending.append((parts, True))
                            pending.extend(((*parts, name), False) for name in os.listdir(child))
                            continue
                        os.fsync(child)
                    os.rmdir(parts[-1], dir_fd=parent)
                    counts["directories"] += 1
                else:
                    os.unlink(parts[-1], dir_fd=parent)  # Also unlinks symlinks/FIFOs without opening them.
                    counts["files" if stat.S_ISREG(info.st_mode) else "symlinks" if stat.S_ISLNK(info.st_mode) else "other"] += 1
        os.fsync(root_fd)
        self.mounts.unmounted(target)
        if any(counts.values()):
            # Preserve the single closed stdout diagnostic; this value-free
            # event is available in the unit journal and private live evidence.
            print(json.dumps({"event": "persistence_residue_cleared", **counts}, separators=(",", ":")), file=sys.stderr, flush=True)
        return counts

    def wait_hydration(self):
        lazy = self.path("/var/lib/ascii-lazy")
        try:
            info = lazy.lstat()
        except FileNotFoundError:
            return  # Fresh stock builders do not have lazy-restore state.
        require(stat.S_ISDIR(info.st_mode), "base_compatibility")
        home = str(self.path("/home/user"))
        started = time.monotonic()
        print(json.dumps({"event": "persistence_hydration_wait", "waitedSeconds": 0}), file=sys.stderr, flush=True)
        while True:
            try:
                marker = (lazy / "hydration-done").lstat()
            except FileNotFoundError:
                done = False
            else:
                require(stat.S_ISREG(marker.st_mode), "base_compatibility")
                done = True
            fuse = any(entry["filesystem"].startswith("fuse") and
                       (entry["target"] == home or entry["target"].startswith(home + "/")) for entry in self.mounts.table())
            waited = time.monotonic() - started
            if done and not fuse:
                print(json.dumps({"event": "persistence_hydration_ready", "waitedSeconds": int(waited)}), file=sys.stderr, flush=True)
                return
            if waited >= HYDRATION_TIMEOUT:
                print(json.dumps({"event": "persistence_hydration_timeout", "waitedSeconds": int(waited)}), file=sys.stderr, flush=True)
                raise Failure("timeout", code=124, timed_out=True)
            time.sleep(min(1, HYDRATION_TIMEOUT - waited))

    def persistence(self, create=False):
        try:
            if create:
                # Do this before opening /home/user: fds and binds pin the
                # transient ascii-lazyfs even after Boat replaces that mount.
                self.wait_hydration()
            boot_id = self.boot_id()
            text_match(boot_id, UUID, "base_compatibility")
            result = {"schema": "zeros.persistence/v1", "bootId": boot_id, "machineIdSha256": self.machine_id(create), "mounts": []}
            residue = {"schema": "zeros.persistence-residue/v1", "bootId": boot_id, "mountPoints": 0,
                       "directories": 0, "files": 0, "symlinks": 0, "other": 0}
            with self.directory("/home", create=create) as home, \
                 self.data_directory(home, "user", *self.account("user"), 0o755, create, exact=False) as user, \
                 self.data_directory(user, ".zeros-persist", self.uid, self.gid, 0o755, create) as backing, \
                 self.directory("/srv/zeros", create=create) as logical:
                for name, owner, group, mode in PERSIST_LAYOUT:
                    uid, gid = self.account(owner)[0], self.account(group)[1]
                    source_name = "files/repos" if name == "repos" else name
                    source, target = self.path(PERSIST_ROOT + "/" + source_name), self.path("/srv/zeros/" + name)
                    with contextlib.ExitStack() as stack:
                        parent = backing
                        if name == "repos":
                            parent = stack.enter_context(self.data_directory(backing, "files", self.uid, self.gid, 0o755, create))
                        source_fd = stack.enter_context(self.data_directory(parent, name, uid, gid, mode, create))
                        with self.data_directory(logical, name, uid, gid, mode, create) as target_fd:
                            if not self.mounts.present(target):
                                require(create, "base_compatibility")
                                require(self.mounts.mount_id(target_fd) == self.mounts.mount_id(logical), "base_compatibility")
                                cleared = self.clear_persistence_residue(target, target_fd)
                                residue["mountPoints"] += int(any(cleared.values()))
                                for key, count in cleared.items():
                                    residue[key] += count
                                self.mounts.bind(source_fd, target_fd)
                        # An fd opened before mount(2) refers to the covered
                        # directory, not the root of the new bind.
                        with self.data_directory(logical, name, uid, gid, mode) as target_fd:
                            identity = self.mounts.verify(source, target, source_fd, target_fd)
                        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                        require((current.st_dev, current.st_ino) == (os.fstat(source_fd).st_dev, os.fstat(source_fd).st_ino),
                                "base_compatibility")
                        result["mounts"].append({"name": name, "source": PERSIST_ROOT + "/" + source_name, "target": "/srv/zeros/" + name,
                                                 "uid": uid, "gid": gid, "mode": f"{mode:04o}", **identity})
                        if create:
                            if name == "files":
                                # Root controls staging/seed entries; Git's
                                # UID/GID 10001 can traverse to its 0700 child.
                                # The engine masks this parent from its view.
                                with self.data_directory(source_fd, ".zeros-setup", self.uid, self.account("agent")[1], 0o710, True):
                                    pass
                                # Empty targets for the engine's existing
                                # namespace overlays, not copies of host data.
                                for point in ("state", "managed-settings", "home"):
                                    with self.data_directory(source_fd, point, self.uid, self.gid, 0o755, True) as view:
                                        if point == "home":
                                            require(set(os.listdir(view)) <= {"agent", "capture"}, "base_compatibility")
                                            for actor in ("agent", "capture"):
                                                with self.data_directory(view, actor, self.uid, self.gid, 0o755, True) as empty:
                                                    require(not os.listdir(empty), "base_compatibility")
                                        else:
                                            require(not os.listdir(view), "base_compatibility")
                            for parent, child, account, child_mode in (("home", "agent", "agent", 0o755),
                                    ("home", "capture", "capture", 0o700), ("state", "workspaces", "engine", 0o700)):
                                if name == parent:
                                    with self.data_directory(source_fd, child, *self.account(account), child_mode, True):
                                        pass
                # These host-owned directories publish regular files only;
                # no user/agent mutable tree or directory rename lives here.
                for name, group, mode in (("setup", "root", 0o700), ("log", "agent", 0o750), ("managed-settings", "agent", 0o750)):
                    gid = self.account(group)[1]
                    with self.data_directory(logical, name, self.uid, gid, mode, create) as host_dir:
                        if create and name == "managed-settings":
                            try:
                                fd = os.open("settings.managed.toml", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                             0o600, dir_fd=host_dir)
                            except FileExistsError:
                                pass
                            else:
                                try:
                                    os.fchown(fd, self.uid, gid)
                                    os.fchmod(fd, 0o640)
                                    os.fsync(fd)
                                    os.fsync(host_dir)
                                finally:
                                    os.close(fd)
            if create:
                with self.directory("/run/zeros", create=True, mode=0o700):
                    pass
                self.atomic(PERSIST_RESIDUE, packed(residue))
            return result
        except OSError as error:
            raise Failure("base_compatibility") from error

    def require_persistence(self):
        try:
            record = strict_json(self.read(PERSIST_RECORD, 16 * 1024, 0o600), "base_compatibility")
            require(record == self.persistence(), "base_compatibility")
        except (FileNotFoundError, KeyError) as error:
            raise Failure("base_compatibility") from error

    def wait_ready(self):
        # Wait for the boot oneshot and dispatch's cgroup initialization;
        # an active Type=simple unit alone does not acknowledge either.
        self.host.wait_ready()
        with self.lock("runtime-publication.lock"):
            require(self.read("/run/zeros/boot-id", 64, 0o600).decode() == self.boot_id(), "host_start")
            require(self.epoch() > 0, "pointer_publish")
            for absolute, target in FACADE_LINKS:
                parent, name = absolute.rsplit("/", 1)
                with self.directory(parent or "/") as directory:
                    st = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    require(stat.S_ISLNK(st.st_mode) and st.st_uid == self.uid and st.st_gid == self.gid, "pointer_publish")
                    require(os.readlink(name, dir_fd=directory) == target, "pointer_publish")
            self.require_persistence()

    def current(self, name="current"):
        with self.directory(FACADE) as directory:
            try:
                st = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                return None
            require(stat.S_ISLNK(st.st_mode) and st.st_uid == self.uid and st.st_gid == self.gid, "pointer_publish")
            target = os.readlink(name, dir_fd=directory)
            require(target.startswith("../zeros-infra/") and RID.fullmatch(target[15:]) is not None, "pointer_publish")
            return target[15:]

    def check_stat(self, st, entry):
        kind = entry["type"]
        require({"file": stat.S_ISREG, "dir": stat.S_ISDIR, "symlink": stat.S_ISLNK}[kind](st.st_mode), "file_inventory")
        require(st.st_uid == self.uid and st.st_gid == self.gid, "root_ownership")
        if kind != "dir":
            require(st.st_nlink == 1, "hard_link")
        if kind != "symlink":
            require(stat.S_IMODE(st.st_mode) == mode_number(entry["mode"]), "file_mode")
        if kind == "file":
            require(st.st_size == entry["size"], "file_inventory")

    def verify_tree(self, root, manifest, raw, full=True):
        expected = {e["path"]: e for e in manifest["files"]}
        expected["manifest.json"] = {"type": "file", "mode": "0444", "size": len(raw), "sha256": sha(raw)}
        seen = set()

        pending = [""]
        while pending:
            prefix = pending.pop()
            # Reopen through checked directory descriptors, keeping both the
            # Python stack and number of open descriptors independent of depth.
            with self.directory(root + ("/" + prefix[:-1] if prefix else "")) as directory:
                for name in os.listdir(directory):
                    relative = prefix + name
                    entry = expected.get(relative)
                    require(entry is not None, "file_inventory")
                    st = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    self.check_stat(st, entry)
                    seen.add(relative)
                    if entry["type"] == "symlink":
                        require(os.readlink(name, dir_fd=directory) == entry["target"], "symlink_escape")
                        continue
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC |
                                 (os.O_DIRECTORY if entry["type"] == "dir" else 0), dir_fd=directory)
                    try:
                        self.check_stat(os.fstat(fd), entry)
                        require(not any(n in os.listxattr(fd) for n in ("security.capability", "system.posix_acl_access", "system.posix_acl_default")), "file_mode")
                        if entry["type"] == "dir":
                            pending.append(relative + "/")
                        elif full or relative == "manifest.json" or relative.startswith(("bin/", "lib/zeros/", "worker/dist-engine/")):
                            with os.fdopen(os.dup(fd), "rb") as stream:
                                require(consume(stream, entry["size"]) == entry["sha256"], "file_digest")
                    finally:
                        os.close(fd)
        require(seen == expected.keys(), "file_inventory")

    def manifest_for(self, runtime_id, descriptor=None):
        text_match(runtime_id, RID, "cache_conflict")
        raw = self.read(INFRA + "/" + runtime_id + "/manifest.json", MAX_MANIFEST, 0o444)
        require(sha(raw) == runtime_id[3:], "manifest_digest")
        if descriptor is None:
            value = strict_json(raw, "manifest_schema")
            try:
                descriptor = {"manifestSha256": runtime_id[3:], "expandedBytes": sum(e.get("size", 0) for e in value["files"]),
                              "nodeModulesAbi": value["platform"]["nodeModulesAbi"], "sourceCommit": value["source"]["commit"],
                              "engineProtocolVersion": value["protocols"]["engine"]}
            except (KeyError, TypeError):
                raise Failure("manifest_schema") from None
        return raw, validate_manifest(raw, descriptor, self.compat)

    def receipt(self, runtime_id, manifest, descriptor=None):
        raw = self.read(RECEIPTS + "/" + runtime_id + ".json", 4096, 0o600)
        value = strict_json(raw, "cache_conflict")
        shape(value, ("archiveSha256", "baseCompatibilityId", "bootstrapVersion", "expandedBytes", "fileCount",
                      "installedAt", "manifestSha256", "runtimeId", "schema"), check="cache_conflict")
        require(value["schema"] == "zeros.runtime-install-receipt/v1" and value["runtimeId"] == runtime_id and
                value["manifestSha256"] == runtime_id[3:] and value["baseCompatibilityId"] == self.compat_id and
                type(value["bootstrapVersion"]) is int and value["bootstrapVersion"] == 1 and
                type(value["fileCount"]) is int and value["fileCount"] == sum(e["type"] == "file" for e in manifest["files"]) and
                type(value["expandedBytes"]) is int and value["expandedBytes"] == sum(e.get("size", 0) for e in manifest["files"]), "cache_conflict")
        text_match(value["archiveSha256"], HEX, "cache_conflict")
        timestamp(value["installedAt"], "cache_conflict")
        if descriptor:
            require(value["archiveSha256"] == descriptor["archiveSha256"], "cache_conflict")
        return raw

    def incomplete_marker(self, runtime_id):
        text_match(runtime_id, RID, "cache_conflict")
        return INFRA + "/" + runtime_id + ".incomplete"

    def runtime_metadata(self, runtime_id, descriptor=None):
        require(not os.path.lexists(self.path(self.incomplete_marker(runtime_id))), "cache_conflict")
        raw, manifest = self.manifest_for(runtime_id, descriptor)
        return raw, manifest, self.receipt(runtime_id, manifest, descriptor)

    def verify_runtime(self, runtime_id, full=True, descriptor=None):
        raw, manifest, receipt = self.runtime_metadata(runtime_id, descriptor)
        self.verify_tree(INFRA + "/" + runtime_id, manifest, raw, full=full)
        return manifest, receipt

    def publish_receipt(self, descriptor, manifest):
        self.stage = "publish_receipt"
        value = {"archiveSha256": descriptor["archiveSha256"], "baseCompatibilityId": self.compat_id,
                 "bootstrapVersion": 1, "expandedBytes": descriptor["expandedBytes"],
                 "fileCount": sum(e["type"] == "file" for e in manifest["files"]),
                 "installedAt": self.now().isoformat().replace("+00:00", "Z"), "manifestSha256": descriptor["manifestSha256"],
                 "runtimeId": descriptor["runtimeId"], "schema": "zeros.runtime-install-receipt/v1"}
        raw = packed(value)
        self.atomic(RECEIPTS + "/" + descriptor["runtimeId"] + ".json", raw)
        self.fault("receipt_published")
        return raw

    def scan_archive(self, archive, descriptor):
        self.stage = "verify_manifest"
        iterator = archive_members(archive)
        first, stream = next(iterator)
        require(first.name == "manifest.json" and first.isfile() and first.mode == 0o444 and first.size <= MAX_MANIFEST,
                "manifest_schema")
        raw = read_exact(stream, first.size)
        manifest = validate_manifest(raw, descriptor, self.compat)
        for expected in manifest["files"]:
            try:
                info, stream = next(iterator)
            except StopIteration:
                raise Failure("file_inventory") from None
            require(info.name == expected["path"], "file_inventory")
            kind = "file" if info.isfile() else "dir" if info.isdir() else "symlink"
            require(kind == expected["type"], "archive_member_type")
            if kind == "symlink":
                require(info.linkname == expected["target"], "symlink_escape")
            else:
                require(info.mode == mode_number(expected["mode"]), "file_mode")
            require(info.size == expected.get("size", 0), "file_inventory")
            consume(stream, info.size)
        require(next(iterator, None) is None, "file_inventory")
        return raw, manifest

    def extract(self, archive, root, raw, manifest):
        self.stage = "extract"
        with self.directory(root):
            pass
        entries = {e["path"]: e for e in manifest["files"]}
        entries["manifest.json"] = {"type": "file", "size": len(raw), "sha256": sha(raw), "mode": "0444"}
        for info, stream in archive_members(archive):
            entry = entries[info.name]
            absolute = root + "/" + info.name
            if entry["type"] == "dir":
                with self.directory(absolute, create=True):
                    pass
            elif entry["type"] == "file":
                parent, name = absolute.rsplit("/", 1)
                with self.directory(parent) as directory:
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
                    with os.fdopen(fd, "wb") as output:
                        require(consume(stream, entry["size"], output) == entry["sha256"], "file_digest")
                        output.flush()
                        os.fchmod(output.fileno(), mode_number(entry["mode"]))
                        os.fsync(output.fileno())
        # No link can redirect an extraction write, even when it sorts first.
        for entry in manifest["files"]:
            if entry["type"] == "symlink":
                parent, name = (root + "/" + entry["path"]).rsplit("/", 1)
                with self.directory(parent) as directory:
                    os.symlink(entry["target"], name, dir_fd=directory)
        for entry in reversed(manifest["files"]):
            if entry["type"] == "dir":
                with self.directory(root + "/" + entry["path"]) as directory:
                    os.fchmod(directory, mode_number(entry["mode"]))
                    os.fsync(directory)
        with self.directory(root) as directory:
            os.fsync(directory)
        self.stage = "verify_tree"
        self.verify_tree(root, manifest, raw)
        self.fault("runtime_verified")

    def remove_entries(self, root, names):
        pending = [(name, False) for name in names]
        # Do not apply admission depth limits to cleanup: a prior version may
        # have left deeper partial trees. This postorder walk never recurses or
        # follows a symlink and has a constant open-descriptor count.
        while pending:
            relative, visited = pending.pop()
            parent, _, name = relative.rpartition("/")
            with self.directory(root + ("/" + parent if parent else "")) as directory:
                try:
                    st = os.stat(name, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                require(st.st_uid == self.uid and st.st_gid == self.gid, "root_ownership")
                if stat.S_ISDIR(st.st_mode):
                    if visited:
                        os.rmdir(name, dir_fd=directory)
                    else:
                        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
                        try:
                            self.owner(os.fstat(fd))
                            os.fchmod(fd, 0o700)
                            pending.append((relative, True))
                            pending.extend((relative + "/" + child, False) for child in os.listdir(fd))
                        finally:
                            os.close(fd)
                else:
                    os.unlink(name, dir_fd=directory)
        with self.directory(root) as directory:
            os.fsync(directory)

    def clean_staging(self):
        root = INFRA + "/.staging"
        with self.directory(root) as directory:
            names = os.listdir(directory)
        self.remove_entries(root, names)

    def incomplete_runtimes(self, descriptor=None):
        # A receipt alone or an unmarked directory alone is not a completed
        # installation. Include dangling pointers and markers left before mkdir.
        with self.directory(INFRA) as directory:
            ids = {name.removesuffix(".incomplete") for name in os.listdir(directory)
                   if RID.fullmatch(name.removesuffix(".incomplete"))}
        with self.directory(RECEIPTS) as directory:
            ids.update(name[:-5] for name in os.listdir(directory) if name.endswith(".json") and RID.fullmatch(name[:-5]))
        ids.update(value for value in (self.current(), self.current("previous")) if value)
        incomplete = []
        for runtime_id in sorted(ids):
            try:
                self.runtime_metadata(runtime_id, descriptor if descriptor and descriptor["runtimeId"] == runtime_id else None)
            except (Failure, FileNotFoundError):
                incomplete.append(runtime_id)
        return incomplete

    def clean_incomplete(self, runtime_ids):
        # Caller holds both locks; boot runs before the host, while install
        # retires a host using an affected current before taking publication.lock.
        for runtime_id in runtime_ids:
            marker = self.incomplete_marker(runtime_id)
            # Keep recovery restartable even if deletion itself is interrupted.
            self.atomic(marker, b"")
            if self.current() == runtime_id:
                self.unlink(ACTIVE)
                self.unlink(FACADE + "/current")
            if self.current("previous") == runtime_id:
                self.unlink(FACADE + "/previous")
            self.unlink(RECEIPTS + "/" + runtime_id + ".json")
            self.remove_entries(INFRA, [runtime_id])
            self.unlink(marker)

    def install(self, encoded_input):
        self.stage = "validate_input"
        self.base()
        value = validate_input(encoded_input, self.compat, self.now())
        self.layout()
        self.stage = "lock"
        # The SSH command owns setup.lock exactly once. This separate lock also
        # serializes boot reconciliation and direct root invocations.
        with self.lock("runtime-install.lock"):
            self.require_persistence()
            if os.path.lexists(self.path(RECEIPTS + "/switch-intent.json")):
                self.stage = "switch_pointer"
                self.host.stop()
                with self.lock("runtime-publication.lock"):
                    self.reconcile()
            self.clean_staging()
            descriptor = value["runtime"]
            runtime_id = descriptor["runtimeId"]
            destination = INFRA + "/" + runtime_id
            self.stage = "check_cache"
            incomplete = self.incomplete_runtimes(descriptor)
            if incomplete:
                if self.current() in incomplete:
                    self.host.stop()
                with self.lock("runtime-publication.lock"):
                    self.clean_incomplete(incomplete)
            if os.path.lexists(self.path(destination)):
                self.verify_runtime(runtime_id, descriptor=descriptor)
            else:
                require(not os.path.lexists(self.path(RECEIPTS + "/" + runtime_id + ".json")), "cache_conflict")
                self.stage = "check_space"
                require(shutil.disk_usage(self.path(INFRA)).free >= descriptor["archiveBytes"] + descriptor["expandedBytes"] + RESERVE,
                        "insufficient_space")
                operation = INFRA + "/.staging/" + uuid.uuid4().hex
                with self.directory(operation, create=True, mode=0o700) as directory:
                    fd = os.open("archive.tar.gz", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
                try:
                    self.stage = "download"
                    with os.fdopen(fd, "w+b") as stream:
                        self.downloader(value["artifact"], stream, descriptor)
                        stream.flush()
                        self.stage = "verify_archive"
                        require(stream.tell() == descriptor["archiveBytes"], "archive_size")
                        stream.seek(0)
                        require(consume(stream, descriptor["archiveBytes"]) == descriptor["archiveSha256"], "archive_digest")
                        os.fsync(stream.fileno())
                    archive = self.path(operation + "/archive.tar.gz")
                    raw, manifest = self.scan_archive(archive, descriptor)
                    self.stage = "extract"
                    with self.lock("runtime-publication.lock"):
                        require(not os.path.lexists(self.path(destination)), "cache_conflict")
                        self.atomic(self.incomplete_marker(runtime_id), b"")
                        self.fault("incomplete_published")
                        # Boat drops the children of renamed directories on
                        # restore. Populate R itself; only files/links are renamed.
                        with self.directory(INFRA) as target:
                            os.mkdir(runtime_id, 0o755, dir_fd=target)
                            os.fsync(target)
                        with self.directory(destination) as directory:
                            os.fchmod(directory, 0o755)
                            os.fsync(directory)
                        self.fault("runtime_created")
                    self.extract(archive, destination, raw, manifest)
                    with self.lock("runtime-publication.lock"):
                        self.publish_receipt(descriptor, manifest)
                        self.unlink(self.incomplete_marker(runtime_id))
                        self.fault("incomplete_removed")
                        # Exercise the same installed-tree/receipt path as
                        # dispatch before switching; full hashes were checked
                        # in R before its receipt and marker were committed.
                        self.stage = "verify_tree"
                        self.verify_runtime(runtime_id, full=False, descriptor=descriptor)
                except Exception:
                    if os.path.lexists(self.path(self.incomplete_marker(runtime_id))):
                        with self.lock("runtime-publication.lock"):
                            self.clean_incomplete([runtime_id])
                    raise
                finally:
                    self.clean_staging()
            self.switch(runtime_id)
            self.stage = "start_host"
            self.host.start(self, runtime_id)
            if value["purpose"] == "workspace-setup":
                self.stage = "run_setup"
                try:
                    code, checks = self.host.setup(str(self.path(destination)), value["setup"])
                except Failure as error:
                    raise Failure("setup_exit", code=error.code, timed_out=error.timed_out) from None
                if code != 0 or checks:
                    raise Failure("setup_exit", code=code or 1, timed_out="timeout" in checks)
            self.stage = "done"
            return 0

    def epoch(self):
        try:
            raw = self.read(FACADE + "/disk-epoch", 32, 0o600)
        except FileNotFoundError:
            return 0
        require(re.fullmatch(rb"[0-9]{1,18}\n", raw) is not None, "pointer_publish")
        return int(raw)

    def switch(self, runtime_id):
        self.stage = "switch_pointer"
        # Stop outside publication.lock: dispatch may be verifying while it
        # holds that lock, and no lifetime engine lock may precede retirement.
        self.host.stop()
        with self.lock("runtime-publication.lock"):
            self.unlink(ACTIVE)
            old = self.current()
            prior = self.current("previous")
            if old != runtime_id:
                intent = {"schema": "zeros.runtime-switch/v1", "old": old, "new": runtime_id,
                          "previous": prior, "epoch": self.epoch() + 1}
                self.atomic(RECEIPTS + "/switch-intent.json", packed(intent))
                self.fault("intent_published")
                if old:
                    self.link(FACADE + "/previous", "../zeros-infra/" + old, replace=True)
                self.fault("previous_published")
                self.link(FACADE + "/current", "../zeros-infra/" + runtime_id, replace=True)
                self.fault("current_published")
                self.atomic(FACADE + "/disk-epoch", (str(intent["epoch"]) + "\n").encode())
                self.fault("epoch_published")
                self.unlink(RECEIPTS + "/switch-intent.json")
                self.fault("intent_removed")
            self.unlink(ACTIVE)

    def reconcile(self):
        try:
            intent = strict_json(self.read(RECEIPTS + "/switch-intent.json", 4096, 0o600), "pointer_publish")
        except FileNotFoundError:
            return
        shape(intent, ("schema", "old", "new", "previous", "epoch"), check="pointer_publish")
        require(intent["schema"] == "zeros.runtime-switch/v1", "pointer_publish")
        for key in ("old", "previous", "new"):
            require((key != "new" and intent[key] is None) or (type(intent[key]) is str and RID.fullmatch(intent[key])), "pointer_publish")
        integer(intent["epoch"], 1, 10**18 - 1, "pointer_publish")
        try:
            current = self.current()
        except Failure:
            current = None
        chosen = None
        if current in (intent["old"], intent["new"]):
            for candidate in dict.fromkeys((current, intent["old"])):
                if candidate:
                    try:
                        self.verify_runtime(candidate, full=True)
                        chosen = candidate
                        break
                    except (Failure, OSError):
                        pass
        if chosen:
            self.link(FACADE + "/current", "../zeros-infra/" + chosen, replace=True)
        else:
            self.unlink(FACADE + "/current")
        previous = intent["old"] if chosen == intent["new"] else intent["previous"]
        if previous:
            self.link(FACADE + "/previous", "../zeros-infra/" + previous, replace=True)
        else:
            self.unlink(FACADE + "/previous")
        self.atomic(FACADE + "/disk-epoch", (str(max(self.epoch(), intent["epoch"])) + "\n").encode())
        self.atomic(FACADE + "/sessions/reconciliation.json", packed({"outcome": "verified_pointer" if chosen else "waiting_for_runtime"}))
        self.unlink(ACTIVE)
        self.unlink(RECEIPTS + "/switch-intent.json")

    def boot(self):
        self.stage = "validate_input"
        self.base()
        self.layout()
        with self.lock("runtime-install.lock"), self.lock("runtime-publication.lock"):
            self.unlink(PERSIST_RECORD)
            self.unlink(PERSIST_RESIDUE)
            # Boat overlays the saved disk after stock early-boot services
            # have run. Reload verified base policy on every invocation,
            # including a retry with the same kernel boot ID.
            self.host.load_apparmor()
            persistence = self.persistence(create=True)
            self.stage = "switch_pointer"
            self.clean_staging()
            self.reconcile()
            self.clean_incomplete(self.incomplete_runtimes())
            boot_id = self.boot_id()
            text_match(boot_id, UUID, "base_compatibility")
            try:
                previous_boot = self.read("/run/zeros/boot-id", 64, 0o600).decode()
            except FileNotFoundError:
                previous_boot = None
            if previous_boot != boot_id:
                # Publish the epoch decision first. Re-running this boot after
                # death at either subsequent write cannot advance it twice.
                try:
                    intent = strict_json(self.read(FACADE + "/sessions/boot.json", 256, 0o600), "pointer_publish")
                    shape(intent, ("bootId", "epoch"), check="pointer_publish")
                    text_match(intent["bootId"], UUID, "pointer_publish")
                    integer(intent["epoch"], 1, 10**18 - 1, "pointer_publish")
                except FileNotFoundError:
                    intent = None
                if intent is None or intent["bootId"] != boot_id:
                    intent = {"bootId": boot_id, "epoch": self.epoch() + 1}
                    self.atomic(FACADE + "/sessions/boot.json", packed(intent))
                self.fault("boot_intent_published")
                self.unlink(ACTIVE)
                self.atomic(FACADE + "/disk-epoch", (str(max(self.epoch(), intent["epoch"])) + "\n").encode())
                self.fault("boot_epoch_published")
                self.atomic("/run/zeros/boot-id", boot_id.encode())
                self.fault("boot_id_published")
            self.atomic(PERSIST_RECORD, packed(persistence))
        self.stage = "done"

    def activate(self, runtime_id, cgroup):
        _, receipt = self.verify_runtime(runtime_id, full=False)
        require(cgroup == CGROUP, "cgroup_controllers")
        boot_id = self.boot_id()
        text_match(boot_id, UUID, "base_compatibility")
        value = {"baseCompatibilityId": self.compat_id, "bootId": boot_id, "cgroupRoot": cgroup,
                 "installerReceiptSha256": sha(receipt), "manifestSha256": runtime_id[3:],
                 "root": INFRA + "/" + runtime_id, "runtimeId": runtime_id,
                 "schema": "zeros.active-runtime/v1", "supervisorSessionId": str(uuid.uuid4())}
        self.atomic(ACTIVE, packed(value))
        return value

    def status(self):
        self.base()
        current = self.current()
        state = self.host.status()
        host_state = "failed" if state == "failed" else "stopped"
        if state == "active":
            try:
                self.require_persistence()
                host_state = "idle" if current else "waiting_for_runtime"
            except (Failure, OSError):
                host_state = "failed"
        return {"schema": "zeros.base-status/v1", "baseCompatibilityId": self.compat_id,
                "bootId": self.boot_id(), "currentRuntimeId": current, "hostState": host_state}

    def dispatch(self):
        self.base()
        self.layout()
        with self.lock("runtime-publication.lock"):
            self.require_persistence()
        cgroup = self.host.cgroup()
        while self.current() is None:
            time.sleep(1)
        with self.lock("runtime-publication.lock"):
            self.require_persistence()
            self.stage = "verify_tree"
            runtime_id = self.current()
            self.activate(runtime_id, cgroup)
        self.stage = "start_host"
        root = INFRA + "/" + runtime_id
        diagnostic("bootstrap", "done", 0)
        os.execve(root + "/bin/node", [root + "/bin/node", root + "/lib/zeros/cloud-worker-supervisor.mjs"], ENV)


class SystemHost:
    def load_apparmor(self):
        try:
            result = subprocess.run(["/usr/sbin/apparmor_parser", "-r", "-W", "/etc/apparmor.d/zeros-cloud-engine"],
                                    env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=30, check=False)
        except subprocess.TimeoutExpired:
            raise Failure("apparmor", code=124, timed_out=True) from None
        except OSError:
            raise Failure("apparmor") from None
        require(result.returncode == 0, "apparmor")

    def wait_ready(self, timeout=HYDRATION_TIMEOUT + 60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = subprocess.run(["/usr/bin/systemctl", "show", "--property=Id,ActiveState,SubState,Result,ExecMainStatus",
                                         "zeros-boot.service", "zeros-host.service"], env=ENV, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
            except subprocess.TimeoutExpired:
                raise Failure("timeout", code=124, timed_out=True) from None
            require(result.returncode == 0 and len(result.stdout) <= 4096, "host_start")
            units = {}
            for block in result.stdout.decode("ascii", "strict").strip().split("\n\n"):
                fields = dict(line.split("=", 1) for line in block.splitlines())
                units[fields["Id"]] = fields
            require(set(units) == {"zeros-boot.service", "zeros-host.service"}, "host_start")
            require(all(unit["ActiveState"] != "failed" for unit in units.values()), "host_start")
            boot, host = units["zeros-boot.service"], units["zeros-host.service"]
            if boot["ActiveState"] == host["ActiveState"] == "active" and boot["SubState"] == "exited" and host["SubState"] == "running":
                require(all(unit["Result"] == "success" and unit["ExecMainStatus"] == "0" for unit in units.values()), "host_start")
                if self.cgroup_ready():
                    return
            time.sleep(0.2)
        raise Failure("timeout", code=124, timed_out=True)

    @staticmethod
    def cgroup_ready():
        scope = Path(CGROUP)
        try:
            return (not (scope / "cgroup.procs").read_text().strip() and
                    {"cpu", "memory", "pids"} <= set((scope / "cgroup.subtree_control").read_text().split()) and
                    all((scope / "host" / name).read_text().strip() == value for name, value in HOST_LIMITS))
        except FileNotFoundError:
            # Controller files may not exist until dispatch enables them.
            return False

    @staticmethod
    def control(*args):
        try:
            return subprocess.run(["/usr/bin/systemctl", *args, "zeros-host.service"], env=ENV,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  timeout=30, check=False)
        except subprocess.TimeoutExpired:
            raise Failure("timeout", code=124, timed_out=True) from None

    def status(self):
        result = self.control("show", "--property=ActiveState", "--value")
        return result.stdout.decode("ascii", "replace").strip() if result.returncode == 0 else "failed"

    def stop(self):
        group = self.control("show", "--property=ControlGroup", "--value")
        require(group.returncode == 0 and group.stdout.strip() in (b"", b"/system.slice/zeros-host.service"), "cgroup_retired")
        require(self.control("stop").returncode == 0, "cgroup_retired")
        scope = Path(CGROUP)
        if scope.exists():
            for directory, children, _ in os.walk(scope):
                for child in children:
                    require(Path(directory) == scope and (child in ("host", "setup") or re.fullmatch(r"engine-[A-Za-z0-9_-]{1,128}", child)), "cgroup_retired")
                require("populated 1" not in (Path(directory) / "cgroup.events").read_text(), "cgroup_retired")

    def cgroup(self):
        require(Path("/proc/self/cgroup").read_text().strip() == "0::/system.slice/zeros-host.service/host", "cgroup_controllers")
        scope = Path(CGROUP)
        for directory in (scope, scope / "host"):
            st = directory.lstat()
            require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and st.st_gid == 0 and not st.st_mode & 0o022, "cgroup_controllers")
        require(not (scope / "cgroup.procs").read_text().strip(), "cgroup_controllers")
        require({"cpu", "memory", "pids"} <= set((scope / "cgroup.controllers").read_text().split()), "cgroup_controllers")
        (scope / "cgroup.subtree_control").write_text("+cpu +memory +pids")
        for name, value in HOST_LIMITS:
            (scope / "host" / name).write_text(value)
        return CGROUP

    def start(self, app, runtime_id):
        require(self.control("reset-failed").returncode == 0, "host_start")
        require(self.control("start").returncode == 0, "host_start")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                active = strict_json(app.read(ACTIVE, 4096, 0o600), "host_start")
                require(active["runtimeId"] == runtime_id and active["baseCompatibilityId"] == app.compat_id and
                        active["bootId"] == app.boot_id() and active["root"] == INFRA + "/" + runtime_id and
                        active["manifestSha256"] == runtime_id[3:] and active["cgroupRoot"] == CGROUP and
                        UUID.fullmatch(active["supervisorSessionId"]) is not None, "host_start")
                _, receipt = app.verify_runtime(runtime_id, full=False)
                require(active["installerReceiptSha256"] == sha(receipt), "host_start")
                require(self.status() == "active", "host_start")
                return
            except FileNotFoundError:
                time.sleep(0.1)
        raise Failure("host_start")

    def setup(self, root, payload):
        return run_setup([root + "/bin/node", root + "/lib/zeros/setup-cloud-workspace.mjs", "--stdin"], payload)


def run_setup(command, payload, timeout=1100):
    """Preserve the legacy helper stdout bytes; its result belongs to the CP.

    The verified helper has no new diagnostic obligation. Only its exit status
    affects the outer installer diagnostic; stderr is never forwarded.
    """
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env=ENV, start_new_session=True)
    output_bytes, last_byte = 0, b""
    remaining = payload.encode("ascii")
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            os.set_blocking(child.stdin.fileno(), False)
            os.set_blocking(child.stdout.fileno(), False)
            selector.register(child.stdin, selectors.EVENT_WRITE)
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise Failure("timeout", code=124, timed_out=True)
                for key, _ in selector.select(0.1):
                    if key.fileobj == child.stdin:
                        try:
                            count = os.write(child.stdin.fileno(), remaining[:8192])
                            remaining = remaining[count:]
                        except BrokenPipeError:
                            remaining = b""
                        if not remaining:
                            selector.unregister(child.stdin)
                            child.stdin.close()
                    else:
                        part = os.read(child.stdout.fileno(), 8192)
                        output_bytes += len(part)
                        require(output_bytes <= MAX_SETUP_OUTPUT, "setup_exit")
                        if part:
                            sys.stdout.buffer.write(part)
                            sys.stdout.buffer.flush()
                            last_byte = part[-1:]
                        if not part:
                            selector.unregister(child.stdout)
                if child.poll() is not None and child.stdin.closed is False:
                    selector.unregister(child.stdin)
                    child.stdin.close()
            try:
                code = child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                raise Failure("timeout", code=124, timed_out=True) from None
        if code < 0:
            return 128 - code, ["process_signal"]
        return code, []
    finally:
        # The setup helper's descendants cannot outlive a failed/cancelled
        # transport. Workload cgroups are retired by the verified helper/host.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        child.stdin.close()
        child.stdout.close()
        if last_byte and last_byte != b"\n":
            # The legacy helper does not append a newline. Its exact output is
            # the prefix; this delimiter starts the final installer line.
            sys.stdout.buffer.write(b"\n")
            sys.stdout.buffer.flush()


def diagnostic(component, stage, code, failure=None):
    checks = failure.checks if failure else []
    if component == "installer" and not set(checks) <= INSTALLER_CHECKS:
        checks = ["diagnostic_missing"]
    value = {"schema": "zeros.diagnostic/v1", "component": component, "stage": stage if stage in STAGES else "validate_input",
             "ok": failure is None, "exitCode": code, "timedOut": bool(failure and failure.timed_out),
             "failedChecks": checks}
    print(packed(value).decode(), flush=True)


def main(argv):
    app = Bootstrap()
    component = "installer" if argv[:1] == ["install"] else "bootstrap"
    failure, code = None, 0

    def interrupted(signum, _frame):
        raise Failure("timeout" if signum == signal.SIGALRM else "process_signal",
                      code=124 if signum == signal.SIGALRM else 128 + signum, timed_out=signum == signal.SIGALRM)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(signum, interrupted)
    try:
        require(argv in (["install", "--stdin"], ["boot"], ["dispatch"], ["status"]), "input_schema")
        require(os.geteuid() == 0 and sys.platform == "linux" and os.uname().machine == "x86_64", "base_compatibility")
        os.umask(0o077)
        if argv[0] == "install":
            signal.alarm(30)
            raw = sys.stdin.buffer.read(MAX_INPUT + 1)
            signal.alarm(1800)
            code = app.install(raw)
        elif argv[0] == "boot":
            signal.alarm(600)
            app.boot()
        elif argv[0] == "dispatch":
            app.dispatch()
        else:
            signal.alarm(30)
            print(packed(app.status()).decode(), flush=True)
            return 0  # The status probe contract is exactly one JSON line.
    except Failure as error:
        failure, code = error, error.code
        if argv == ["dispatch"] and code == 1 and set(error.checks) <= PERMANENT_DISPATCH_CHECKS:
            # EX_DATAERR is excluded from systemd restarts. The unit remains
            # failed and retains its closed diagnostic until an explicit start.
            failure.code = code = 65
    except OSError as error:
        failure = Failure("insufficient_space" if error.errno == errno.ENOSPC else STAGE_CHECK.get(app.stage, "diagnostic_missing"))
        failure.__cause__ = error
        code = 1
    except BaseException as error:
        failure, code = Failure(STAGE_CHECK.get(app.stage, "diagnostic_missing")), 1
        failure.__cause__ = error
    finally:
        signal.alarm(0)
    if failure is not None:
        app.log_failure(failure)
    diagnostic(component, app.stage, code, failure)
    return code


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        # The caller must classify an absent diagnostic as diagnostic_missing.
        # Exit without Python's final stdout flush, which would print a traceback.
        os._exit(1)
