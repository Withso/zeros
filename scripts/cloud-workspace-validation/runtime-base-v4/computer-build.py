#!/usr/bin/python3 -I
"""Base-owned Cloud Computer helpers. No shell text or token enters an argv.

Install recipes are trusted administrator root code (D3), not an adversarial
root sandbox. Verification code and its hashes belong to the approved base;
the control plane holds the baseline digest across the recipe execution.
"""
import codecs
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

sys.dont_write_bytecode = True
MAX_INPUT = 262_144
MAX_LOG = 1_048_576
LINE_LIMIT = 8192
REDACTED = "[redacted]"
ENVIRONMENT = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}


class Failure(Exception):
    def __init__(self, check): self.check = check


def require(condition, check="input_schema"):
    if not condition: raise Failure(check)


def sha(value): return hashlib.sha256(value).hexdigest()
def packed(value): return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def strict_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def shape(value, required, optional=()):
    require(type(value) is dict and set(required) <= value.keys() and value.keys() <= set(required) | set(optional))


def job(value):
    require(type(value.get("buildId")) is str and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value["buildId"]))
    require(type(value.get("workerFence")) is int and 0 < value["workerFence"] <= 9_007_199_254_740_991)


def atomic(path, value, mode=0o600):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY | os.O_CLOEXEC)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_file(path, limit, *, owner=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_size <= limit, "file_metadata")
        require(owner is None or metadata.st_uid == owner, "file_metadata")
        value = stream.read(limit + 1)
        require(len(value) <= limit, "file_metadata")
        return value


def clean_log(value):
    value = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", "", value)
    value = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", value)
    value = re.sub(r"https?://[^\s<>\"']+", REDACTED, value, flags=re.I)
    value = re.sub(r"\b(?:Bearer|Basic)\s+[^\s\"']*", REDACTED, value, flags=re.I)
    value = re.sub(r"\b(?:gh[spou]_|github_pat_|condw_|sk[_-])[A-Za-z0-9._+/=-]*", REDACTED, value)
    value = re.sub(r"([\"']?[A-Za-z0-9_]*(?:token|secret|password|credential|api_key|authorization)[\"']?\s*[:=]\s*)(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s,;]+)",
                   lambda match: match[1] + REDACTED, value, flags=re.I)
    return re.sub(r"\b[A-Za-z0-9_+/=-]{32,}(?:\.[A-Za-z0-9_+/=-]+)*\b", REDACTED, value)


class LogFilter:
    """Complete literal replacement precedes prefix withholding, like the CP
    and engine streaming filters. Token patterns see bounded complete lines."""
    def __init__(self, values):
        require(type(values) is list and len(values) <= 32)
        require(all(type(value) is str and len(value) <= 16384 for value in values))
        self.values = sorted({part for value in values if value for part in (value, json.dumps(value, ensure_ascii=False)[1:-1])}, key=len, reverse=True)
        self.streams = {}

    def state(self, key):
        require(key in ("stdout", "stderr"))
        return self.streams.setdefault(key, {"literal": "", "line": "", "dropping": False})

    def clean(self, value):
        output = clean_log(value)
        for secret in self.values:
            for part in secret.split("\n"):
                if part: output = output.replace(part, REDACTED)
        for secret in self.values:
            for size in range(min(len(secret) - 1, len(output)), 0, -1):
                if output.endswith(secret[:size]):
                    output = output[:-size] + REDACTED
                    break
        return output

    def lines(self, state, value):
        output = []
        parts = value.split("\n")
        for index, part in enumerate(parts):
            if not state["dropping"]:
                if len(state["line"].encode()) + len(part.encode()) > LINE_LIMIT:
                    state["line"], state["dropping"] = "", True
                    output.append("[build log line truncated]")
                else: state["line"] += part
            if index < len(parts) - 1:
                output.append(("" if state["dropping"] else self.clean(state["line"])) + "\n")
                state["line"], state["dropping"] = "", False
        return "".join(output)

    def push(self, key, chunk):
        state = self.state(key)
        value = state["literal"] + chunk
        for secret in self.values: value = value.replace(secret, REDACTED)
        keep = 0
        for secret in self.values:
            for size in range(min(len(secret) - 1, len(value)), keep, -1):
                if value.endswith(secret[:size]):
                    keep = size
                    break
        state["literal"] = value[-keep:] if keep else ""
        return self.lines(state, value[:-keep] if keep else value)

    def finish(self, key):
        state = self.state(key)
        output = self.lines(state, REDACTED) if state["literal"] else ""
        output += self.clean(state["line"])
        del self.streams[key]
        return output


class InstallStore:
    def __init__(self, directory, identity):
        self.directory, self.identity = directory, identity
        self.path = directory / "install.json"

    def initialize(self, digest):
        if self.path.exists():
            require(self.read()["inputDigest"] == digest, "install_identity")
            return False
        atomic(self.path, packed({**self.identity, "inputDigest": digest, "state": "running", "exitCode": None,
                                 "timedOut": False, "chunks": [], "seq": 0, "truncated": False, "startedAt": time.time()}))
        return True

    def read(self):
        value = strict_json(read_file(self.path, 8 * MAX_LOG, owner=os.geteuid()))
        require(all(value.get(key) == item for key, item in self.identity.items()), "install_identity")
        require(value["state"] in ("running", "succeeded", "failed") and type(value["chunks"]) is list, "install_identity")
        return value

    def append(self, stream, text):
        if not text: return
        value = self.read()
        pending, pending_bytes = "", 0
        for character in text:
            size = len(character.encode())
            if pending_bytes + size > LINE_LIMIT:
                value["seq"] += 1
                value["chunks"].append({"seq": value["seq"], "stream": stream, "text": pending})
                pending, pending_bytes = "", 0
            pending += character
            pending_bytes += size
        if pending:
            value["seq"] += 1
            value["chunks"].append({"seq": value["seq"], "stream": stream, "text": pending})
        size = sum(len(row["text"].encode()) for row in value["chunks"])
        while value["chunks"] and size > MAX_LOG - LINE_LIMIT:
            size -= len(value["chunks"].pop(0)["text"].encode())
            value["truncated"] = True
        atomic(self.path, packed(value))

    def finish(self, exit_code, timed_out):
        value = self.read()
        value.update(state="succeeded" if exit_code == 0 and not timed_out else "failed", exitCode=exit_code, timedOut=timed_out)
        atomic(self.path, packed(value))

    def status(self, after):
        value = self.read()
        chunks = [row for row in value["chunks"] if row["seq"] > after][:8]
        # Do not report completion until this reader has drained the final logs.
        drained = not chunks or chunks[-1]["seq"] == value["seq"]
        return {"schema": "zeros.computer-install/v1", **self.identity, "state": value["state"] if drained else "running",
                "exitCode": value["exitCode"] if drained else None, "timedOut": value["timedOut"] if drained else False,
                "chunks": chunks, "nextAfter": chunks[-1]["seq"] if chunks else after, "truncated": value["truncated"]}


def kill_group(process):
    try: os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError: pass


def run_process(args, script, timeout, store, redactor, cwd, after_exit=None):
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
                               env=ENVIRONMENT, start_new_session=True)
    start = time.monotonic()
    timed_out, exit_code = False, 1
    try:
        process.stdin.write(script.encode())
        process.stdin.close()
        with selectors.DefaultSelector() as selector:
            for key, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, (key, codecs.getincrementaldecoder("utf8")("replace")))
            while selector.get_map():
                if time.monotonic() - start >= timeout:
                    timed_out = True
                    kill_group(process)
                if process.poll() is not None: kill_group(process)
                for event, _mask in selector.select(0.05):
                    key, decoder = event.data
                    data = os.read(event.fileobj.fileno(), 4096)
                    store.append(key, redactor.push(key, decoder.decode(data, final=not data)))
                    if not data:
                        selector.unregister(event.fileobj)
                        store.append(key, redactor.finish(key))
                require(time.monotonic() - start <= timeout + 5, "install_exit")
        exit_code = process.wait(timeout=2)
    except BaseException:
        kill_group(process)
        process.wait(timeout=2)
    finally:
        kill_group(process)
        for stream in (process.stdout, process.stderr): stream.close()
        if after_exit:
            try: after_exit()
            except BaseException: exit_code = 1
        store.finish(exit_code, timed_out)


def bounded_command(args, *, cwd=None, environment=None, timeout=60, limit=8 * 1024 * 1024):
    process = subprocess.Popen(args, cwd=cwd, env=environment or ENVIRONMENT, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    output = bytearray()
    start = time.monotonic()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                require(time.monotonic() - start < timeout, "command_timeout")
                for _event, _mask in selector.select(0.05):
                    data = os.read(process.stdout.fileno(), 65536)
                    if not data: selector.unregister(process.stdout)
                    output.extend(data)
                    require(len(output) <= limit, "output_limit")
        return process.wait(timeout=2), bytes(output)
    finally:
        kill_group(process)
        process.wait(timeout=2)
        process.stdout.close()


class SystemHost:
    def install_command(self, identity, timeout):
        return ["/usr/bin/systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--unit=zeros-computer-install-" + identity,
                "--property=User=0", "--property=Group=0", "--property=KillMode=control-group", "--property=SendSIGKILL=yes",
                "--property=TimeoutStopSec=5s", "--property=RuntimeMaxSec=" + str(timeout) + "s", "--property=TasksMax=512",
                "--property=MemoryMax=4G", "--property=CPUQuota=200%", "--property=Delegate=no", "--property=UMask=0022",
                "--property=ReadOnlyPaths=/opt/zeros-bootstrap", "--property=ProtectControlGroups=yes",
                "--property=WorkingDirectory=/srv/zeros/files/repos", "--setenv=LANG=C.UTF-8", "--setenv=PATH=" + ENVIRONMENT["PATH"],
                "/usr/bin/bash", "-euo", "pipefail"]

    def drain_install(self, identity):
        unit = "zeros-computer-install-" + identity + ".service"
        bounded_command(["/usr/bin/systemctl", "stop", unit], timeout=15)
        code, output = bounded_command(["/usr/bin/systemctl", "show", "--property=ControlGroup", "--value", unit], timeout=15, limit=4096)
        group = output.decode().strip()
        if code != 0:
            status, state = bounded_command(["/usr/bin/systemctl", "show", "--property=LoadState", "--value", unit], timeout=15, limit=4096)
            require(status in (0, 1, 4) and state.strip() == b"not-found", "install_exit")
            return
        if not group: return
        require(group.startswith("/") and ".." not in group.split("/"), "install_exit")
        events = Path("/sys/fs/cgroup" + group + "/cgroup.events")
        require(not events.exists() or "populated 0" in read_file(events, 4096).decode(), "install_exit")

    def stop_host(self):
        code, _ = bounded_command(["/usr/bin/systemctl", "stop", "zeros-host.service"], timeout=30)
        require(code == 0, "sanitation_failed")

    def clear_journal(self):
        code, _ = bounded_command(["/usr/bin/journalctl", "--rotate"], timeout=15)
        require(code == 0, "sanitation_failed")
        code, _ = bounded_command(["/usr/bin/journalctl", "--vacuum-size=1"], timeout=15)
        require(code == 0, "sanitation_failed")


class CredentialSocket:
    def __init__(self, path, credential):
        self.path, self.credential = path, credential
        self.done = threading.Event()

    def __enter__(self):
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(self.path))
        self.path.chmod(0o600)
        self.listener.listen(4)
        self.listener.settimeout(0.1)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()
        return self

    def serve(self):
        while not self.done.is_set():
            try:
                connection, _ = self.listener.accept()
                with connection:
                    connection.settimeout(2)
                    require(struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1] == os.geteuid())
                    request = connection.recv(16)
                    value = b"x-access-token" if request == b"username" else self.credential.encode() if request == b"password" else b""
                    connection.sendall(value)
            except (TimeoutError, socket.timeout): pass
            except BaseException: return

    def __exit__(self, *_):
        self.done.set()
        self.thread.join(timeout=3)
        self.listener.close()
        self.path.unlink(missing_ok=True)
        self.credential = ""


class ComputerBuild:
    def __init__(self, root=Path("/"), *, uid=0, gid=0, repo_uid=10001, repo_gid=10001):
        self.root = Path(root)
        self.uid, self.gid = uid, gid
        self.repo_uid, self.repo_gid = repo_uid, repo_gid
        self.host = SystemHost()

    def path(self, path):
        require(path.startswith("/") and not set(path.split("/")) & {".", ".."})
        return self.root / path.lstrip("/")

    def ancestry(self, path):
        # Check every directory component without following a repository link.
        for ancestor in reversed(path.relative_to(self.root).parents):
            absolute = self.root / ancestor
            if os.path.lexists(absolute): require(stat.S_ISDIR(absolute.lstat().st_mode), "file_metadata")

    def directory(self, path, mode=0o755):
        target = self.path(path)
        current = self.root
        for part in target.relative_to(self.root).parts:
            current /= part
            if not current.exists(): current.mkdir(mode=mode if current == target else 0o755)
            require(stat.S_ISDIR(current.lstat().st_mode), "file_metadata")
        return target

    def job_directory(self, value):
        job(value)
        target = self.directory("/run/zeros/computer-build/" + value["buildId"], 0o700)
        require(target.stat().st_uid == self.uid and stat.S_IMODE(target.stat().st_mode) == 0o700, "file_metadata")
        return target

    def git(self, args, cwd, environment=None, timeout=60):
        config = {**ENVIRONMENT, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0",
                  "GIT_LFS_SKIP_SMUDGE": "1", **(environment or {})}
        command = ["/usr/bin/git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                   "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "submodule.recurse=false",
                   "-c", "safe.directory=" + str(cwd), *args]
        code, output = bounded_command(command, cwd=cwd, environment=config, timeout=timeout)
        require(code == 0, "repository_clone_failed")
        return output

    def clean_git_config(self, target, repository):
        for path in (target / ".git", target / ".git/config"):
            require(not path.is_symlink(), "repository_metadata")
        config = ("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n"
                  "[remote \"origin\"]\n\turl = https://github.com/" + repository["owner"] + "/" + repository["name"] + ".git\n"
                  "\tfetch = +refs/heads/*:refs/remotes/origin/*\n")
        atomic(target / ".git/config", config.encode(), 0o644)
        self.remove(target / ".git/hooks")

    def repository_tree(self, target):
        require(target.is_dir() and not target.is_symlink(), "repository_metadata")
        count = 0
        for parent, directories, files in os.walk(target, followlinks=False):
            require(len(Path(parent).relative_to(target).parts) <= 128, "repository_metadata")
            for name in [*directories, *files]:
                path = Path(parent) / name
                count += 1
                require(count <= 250_000 and len(str(path).encode()) <= 4096, "repository_metadata")
                metadata = path.lstat()
                require(stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode), "repository_metadata")
                require(not metadata.st_mode & 0o6000, "repository_metadata")
                if stat.S_ISREG(metadata.st_mode): require(metadata.st_nlink == 1, "repository_metadata")
                if stat.S_ISLNK(metadata.st_mode):
                    require(not os.path.isabs(os.readlink(path)), "repository_metadata")
                    try: require(path.resolve().is_relative_to(target), "repository_metadata")
                    except (RuntimeError, OSError): raise Failure("repository_metadata") from None
        for path in (".git/objects/info/alternates", ".git/commondir", ".git/worktrees", ".gitmodules"):
            require(not os.path.lexists(target / path), "repository_metadata")

    def verify_repository(self, target, repository):
        self.repository_tree(target)
        self.clean_git_config(target, repository)
        revision = self.git(["rev-parse", "--verify", "HEAD"], target).decode().strip()
        require(re.fullmatch(r"[a-f0-9]{40}", revision), "repository_metadata")
        require(repository.get("sha", revision) == revision, "repository_metadata")
        files = self.git(["ls-files", "--stage", "-z"], target).split(b"\0")
        for entry in files:
            if not entry: continue
            attributes, path = entry.split(b"\t", 1)
            require(not attributes.startswith(b"160000"), "repository_unsupported")
            file = target / os.fsdecode(path)
            if file.is_file() and not file.is_symlink():
                with file.open("rb") as stream: require(stream.read(256).split(b"\n", 1)[0] != b"version https://git-lfs.github.com/spec/v1", "repository_unsupported")
        for parent, directories, files in os.walk(target, followlinks=False):
            for name in [*directories, *files]: os.chown(Path(parent) / name, self.repo_uid, self.repo_gid, follow_symlinks=False)
        os.chown(target, self.repo_uid, self.repo_gid, follow_symlinks=False)
        return {"id": repository["id"], "owner": repository["owner"], "name": repository["name"], "sha": revision}

    def repository_identity(self, repository):
        require(type(repository["id"]) is str and re.fullmatch(r"[1-9][0-9]{0,39}", repository["id"]))
        for key in ("owner", "name"):
            require(type(repository[key]) is str and re.fullmatch(r"[a-z0-9_.-]{1,100}", repository[key]) and repository[key] not in (".", ".."))
        return "/srv/zeros/files/repos/" + repository["owner"] + "/" + repository["name"]

    def clone_repos(self, value):
        shape(value, ("schema", "buildId", "workerFence", "repositories"))
        require(value["schema"] == "zeros.computer-repositories-input/v1")
        directory = self.job_directory(value)
        require(type(value["repositories"]) is list and len(value["repositories"]) <= 20)
        self.directory("/srv/zeros/files/repos")
        manifest, seen, paths = [], set(), set()
        for repository in value["repositories"]:
            shape(repository, ("id", "owner", "name", "ref", "credential"))
            path = self.repository_identity(repository)
            require(repository["id"] not in seen and path not in paths)
            seen.add(repository["id"]); paths.add(path)
            ref = repository["ref"] or "HEAD"
            require(type(ref) is str and 1 <= len(ref) <= 512 and not re.search(r"[\x00-\x20\x7f~^:?*\[\\]", ref)
                    and not ref.startswith(("-", "/")) and not ref.endswith(("/", ".")) and not any(part in ref for part in ("..", "//", "@{")))
            credential = repository["credential"]
            shape(credential, ("token", "expiresAt"))
            token = credential["token"]
            require(type(token) is str and 1 <= len(token) <= 4096 and not re.search(r"[\x00-\x20\x7f]", token))
            require(datetime.datetime.fromisoformat(credential["expiresAt"].replace("Z", "+00:00")).timestamp() > time.time() + 30, "repository_access_denied")
            require(not os.path.lexists(self.path(path)), "repository_metadata")
            target = self.directory(path)
            self.git(["init", "--quiet"], target)
            address = directory / "git-credential.sock"
            with CredentialSocket(address, token):
                self.git(["fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", "https://github.com/" + repository["owner"] + "/" + repository["name"] + ".git", ref],
                         target, {"GIT_ASKPASS": "/opt/zeros-bootstrap/computer-git-askpass.py", "ZEROS_COMPUTER_ASKPASS_SOCKET": str(address)}, 240)
            self.git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], target)
            expected = {**repository, **({"sha": ref} if re.fullmatch(r"[a-f0-9]{40}", ref) else {})}
            manifest.append(self.verify_repository(target, expected))
        return {"schema": "zeros.computer-repositories/v1", "buildId": value["buildId"], "repositories": manifest}

    def run_install(self, value):
        shape(value, ("schema", "buildId", "workerFence", "action", "after"), ("script", "timeoutSeconds", "redactions"))
        require(value["schema"] == "zeros.computer-install-input/v1" and value["action"] in ("start", "poll"))
        require(type(value["after"]) is int and value["after"] >= 0)
        directory = self.job_directory(value)
        identity = {key: value[key] for key in ("buildId", "workerFence")}
        store = InstallStore(directory, identity)
        lock = os.open(directory / "install.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if value["action"] == "start":
                require(type(value.get("script")) is str and len(value["script"].encode()) <= 16_384 and "\0" not in value["script"])
                require(type(value.get("timeoutSeconds")) is int and 1 <= value["timeoutSeconds"] <= 900)
                redactor = LogFilter(value.get("redactions"))
                digest = sha(packed({**identity, "script": value["script"], "timeoutSeconds": value["timeoutSeconds"]}))
                if store.initialize(digest):
                    pid = os.fork()
                    if pid == 0:
                        os.close(lock)
                        os.setsid()
                        null = os.open("/dev/null", os.O_RDWR)
                        for fd in (0, 1, 2): os.dup2(null, fd)
                        os.close(null)
                        try:
                            run_process(self.host.install_command(value["buildId"], value["timeoutSeconds"]), value["script"], value["timeoutSeconds"], store,
                                        redactor, self.path("/srv/zeros/files/repos"), lambda: self.host.drain_install(value["buildId"]))
                        except BaseException: store.finish(1, False)
                        os._exit(0)
            return store.status(value["after"])
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            os.close(lock)

    def protected_ancestors(self, target):
        result = {}
        for relative in reversed(target.relative_to(self.root).parents):
            ancestor = self.root / relative
            if not os.path.lexists(ancestor): continue
            metadata = ancestor.lstat()
            require(metadata.st_uid == self.uid and metadata.st_gid == self.gid, "tcb_modified")
            if stat.S_ISLNK(metadata.st_mode):
                resolved = ancestor.resolve()
                require(resolved.is_relative_to(self.root) and resolved.is_dir(), "tcb_modified")
                result[str(relative)] = {"link": os.readlink(ancestor)}
                metadata = resolved.stat()
            require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == self.uid and metadata.st_gid == self.gid and not metadata.st_mode & 0o022, "tcb_modified")
        return result

    def snapshot(self, path, recursive=False):
        target = self.path(path)
        ancestors = self.protected_ancestors(target)
        if not os.path.lexists(target): return {"absent": True}
        metadata = target.lstat()
        require(metadata.st_uid == self.uid and metadata.st_gid == self.gid, "tcb_modified")
        require(stat.S_ISLNK(metadata.st_mode) or not metadata.st_mode & 0o022, "tcb_modified")
        result = {"mode": metadata.st_mode & 0o7777, "uid": metadata.st_uid, "gid": metadata.st_gid, "ancestors": ancestors}
        if stat.S_ISLNK(metadata.st_mode):
            result["link"] = os.readlink(target)
        elif stat.S_ISREG(metadata.st_mode):
            require(metadata.st_nlink == 1, "tcb_modified")
            digest = hashlib.sha256()
            with target.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""): digest.update(chunk)
            result["sha256"] = digest.hexdigest()
            result["capability"] = os.getxattr(target, "security.capability").hex() if "security.capability" in os.listxattr(target) else ""
        elif stat.S_ISDIR(metadata.st_mode):
            if recursive:
                entries = sorted(os.listdir(target))
                require(len(entries) <= 4096, "tcb_modified")
                result["entries"] = {name: self.snapshot(path.rstrip("/") + "/" + name, True) for name in entries}
        else: raise Failure("tcb_modified")
        return result

    def protected_snapshot(self, build_id):
        paths = {"/opt/zeros-bootstrap", "/etc/zeros", "/etc/sudoers", "/etc/sudoers.d", "/etc/apparmor.d/zeros-cloud-engine",
                 "/etc/apparmor.d/local/zeros-cloud-engine", "/etc/tmpfiles.d/zeros.conf", "/usr/lib/tmpfiles.d/zeros.conf",
                 "/run/tmpfiles.d/zeros.conf", "/opt/zeros-runtime", "/etc/nsswitch.conf"}
        for base in ("/etc/systemd/system", "/run/systemd/system", "/run/systemd/transient", "/usr/local/lib/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"):
            paths.add(base + "/service.d")
            root = self.path(base)
            if root.is_dir():
                for parent, directories, files in os.walk(root, followlinks=False):
                    require(len(Path(parent).relative_to(root).parts) <= 16, "tcb_modified")
                    for name in [*directories, *files]:
                        if name.startswith("zeros-") and name != "zeros-computer-install-" + build_id + ".service":
                            paths.add("/" + str((Path(parent) / name).relative_to(self.root)))
        snapshot = {path: self.snapshot(path, True) for path in sorted(paths)}
        facade = self.path("/opt/zeros")
        require(facade.is_dir() and not facade.is_symlink(), "tcb_modified")
        epoch = self.path("/opt/zeros/disk-epoch")
        if os.path.lexists(epoch):
            metadata = self.snapshot("/opt/zeros/disk-epoch")
            require(metadata["mode"] == 0o600 and "sha256" in metadata
                    and re.fullmatch(rb"[0-9]{1,18}\n", read_file(epoch, 32, owner=self.uid)), "tcb_modified")
        # Epoch values and session payloads are generated on each boot and are
        # scrubbed before capture. Their protected parents/pointers still count.
        snapshot["/opt/zeros"] = {"directory": self.snapshot("/opt/zeros"),
                                  "entries": {name: self.snapshot("/opt/zeros/" + name) for name in sorted(os.listdir(facade)) if name != "disk-epoch"}}
        snapshot["/zeros"] = self.snapshot("/zeros")
        principals = {"root", "zeros-agent", "zeros-capture", "zeros-engine", "zeros-coordinator"}
        ids = {"0", "10001", "10002", "10003", "10004"}
        for database in ("passwd", "group", "subuid", "subgid"):
            raw = read_file(self.path("/etc/" + database), 1_048_576).decode()
            metadata = self.snapshot("/etc/" + database)
            del metadata["sha256"]
            rows = []
            for line in raw.splitlines():
                fields = line.split(":")
                if fields[0] in principals or fields[0] in ids or (database in ("passwd", "group") and len(fields) >= 4 and fields[2] in ids):
                    rows.append(line)
            snapshot["/etc/" + database] = {"metadata": metadata, "rows": sorted(rows)}
        for database in ("uid_map", "gid_map"):
            path = self.path("/proc/self/" + database)
            snapshot[database] = path.read_text() if path.exists() else "fixture"
        profiles_path = self.path("/sys/kernel/security/apparmor/profiles")
        if self.root == Path("/") or profiles_path.exists():
            with profiles_path.open() as stream:
                profiles = stream.read(1_048_577)
            require(len(profiles) <= 1_048_576, "tcb_modified")
            snapshot["apparmor_loaded"] = sorted(line for line in profiles.splitlines() if line.startswith("zeros-cloud-engine "))
            # The approved v4 profile intentionally grants userns with the
            # unconfined flag. Preserve its loaded mode in the external digest;
            # the verified namespace launcher owns the isolation policy.
            require(len(snapshot["apparmor_loaded"]) == 1 and re.fullmatch(
                r"zeros-cloud-engine \((?:enforce|unconfined)\)", snapshot["apparmor_loaded"][0]), "tcb_modified")
        if self.root == Path("/"):
            # Verification/launch dependencies are part of the externally held
            # baseline. Ordinary unrelated package additions remain permitted.
            dependencies = set()
            for line in Path("/proc/self/maps").read_text().splitlines():
                parts = line.split()
                if parts[-1].startswith("/"): dependencies.add(parts[-1])
            for binary in ("/usr/bin/python3", "/usr/bin/bash", "/usr/bin/git", "/usr/bin/sudo", "/usr/bin/systemd-run", "/usr/bin/systemctl", "/usr/bin/ldd"):
                dependencies.add(binary); dependencies.add(str(Path(binary).resolve()))
                _code, output = bounded_command(["/usr/bin/ldd", binary], timeout=10, limit=65536)
                dependencies.update(re.findall(r"/[^\s()]+", output.decode()))
            for path in sorted(dependencies):
                snapshot[path] = self.snapshot(path)
        return snapshot

    def verify_tcb(self, value):
        shape(value, ("schema", "buildId", "workerFence", "runtimeId", "baseCompatibilityId", "action"), ("protectedContractDigest",))
        job(value)
        require(value["schema"] == "zeros.computer-tcb-input/v1" and value["action"] in ("baseline", "verify"))
        require(re.fullmatch(r"r1-[a-f0-9]{64}", value["runtimeId"]) and re.fullmatch(r"bc1-[a-f0-9]{64}", value["baseCompatibilityId"]))
        raw = read_file(self.path("/opt/zeros-bootstrap/compatibility.json"), 262_144, owner=self.uid)
        require("bc1-" + sha(raw) == value["baseCompatibilityId"], "tcb_modified")
        compatibility = strict_json(raw)
        protected = compatibility["protectedFiles"]
        require(type(protected) is list and 1 <= len(protected) <= 128, "tcb_modified")
        require({"/opt/zeros-bootstrap/bootstrap.py", "/opt/zeros-bootstrap/computer-build.py", "/opt/zeros-bootstrap/computer-git-askpass.py"}
                <= {entry["path"] for entry in protected}, "tcb_modified")
        for entry in protected:
            actual = self.snapshot(entry["path"])
            require(actual.get("sha256") == entry["sha256"] and actual["mode"] == int(entry["mode"], 8), "tcb_modified")
        # Import only after the registry-pinned base digest and bootstrap bytes
        # have been checked. The runtime's own manifest is not its authority.
        spec = importlib.util.spec_from_file_location("zeros_bootstrap", self.path("/opt/zeros-bootstrap/bootstrap.py"))
        bootstrap = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bootstrap)
        app = bootstrap.Bootstrap(root=self.root, uid=self.uid, gid=self.gid)
        app.base()
        require(app.current() == value["runtimeId"], "tcb_modified")
        app.verify_runtime(value["runtimeId"], full=True)
        runtime = self.path("/opt/zeros-infra/" + value["runtimeId"])
        for parent, _directories, files in os.walk(runtime, followlinks=False):
            for name in files:
                path = Path(parent) / name
                require("security.capability" not in os.listxattr(path, follow_symlinks=False), "tcb_modified")
        digest = sha(packed({"baseCompatibilityId": value["baseCompatibilityId"], "runtimeId": value["runtimeId"], "protected": self.protected_snapshot(value["buildId"])}))
        if value["action"] == "verify": require(digest == value.get("protectedContractDigest"), "tcb_modified")
        return {"schema": "zeros.computer-tcb/v1", "buildId": value["buildId"], "runtimeId": value["runtimeId"],
                "baseCompatibilityId": value["baseCompatibilityId"], "protectedContractDigest": digest}

    def remove(self, target):
        if target.is_symlink() or target.is_file(): target.unlink()
        elif target.is_dir(): shutil.rmtree(target)

    def clear_directory(self, path, keep=()):
        target = self.path(path)
        if not os.path.lexists(target): return
        self.ancestry(target)
        require(target.is_dir() and not target.is_symlink(), "sanitation_failed")
        for child in target.iterdir():
            if child.name not in keep: self.remove(child)

    def sanitize(self, value):
        shape(value, ("schema", "buildId", "workerFence", "manifest", "manifestSha256"))
        job(value)
        require(value["schema"] == "zeros.computer-sanitation-input/v1")
        manifest = value["manifest"]
        shape(manifest, ("schema", "buildId", "configId", "baseImageId", "runtimeId", "baseCompatibilityId", "repositoryManifest", "protectedContractDigest"))
        require(manifest["schema"] == "zeros.computer-template/v1" and manifest["buildId"] == value["buildId"]
                and sha(packed(manifest)) == value["manifestSha256"], "sanitation_failed")
        self.verify_tcb({"schema": "zeros.computer-tcb-input/v1", **{key: value[key] for key in ("buildId", "workerFence")},
                         "runtimeId": manifest["runtimeId"], "baseCompatibilityId": manifest["baseCompatibilityId"],
                         "action": "verify", "protectedContractDigest": manifest["protectedContractDigest"]})
        require(type(manifest["repositoryManifest"]) is list and len(manifest["repositoryManifest"]) <= 20)
        for repository in manifest["repositoryManifest"]:
            shape(repository, ("id", "owner", "name", "sha"))
            target = self.path(self.repository_identity(repository))
            require(self.verify_repository(target, repository) == repository, "repository_metadata")
        self.host.stop_host()
        self.host.clear_journal()
        # Keep B4's directory inodes, ownership and modes. Boat loses data on
        # directory rename, and these private roots are used before setup.
        self.clear_directory("/srv/zeros/state", ("workspaces",))
        self.clear_directory("/srv/zeros/home", ("agent", "capture"))
        self.clear_directory("/srv/zeros/files", ("repos",))
        self.clear_directory("/srv/zeros/managed-settings", ("settings.managed.toml",))
        managed = self.path("/srv/zeros/managed-settings/settings.managed.toml")
        if os.path.lexists(managed):
            metadata = managed.lstat()
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "sanitation_failed")
            fd = os.open(managed, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC)
            try: os.fsync(fd)
            finally: os.close(fd)
        for path in ("/srv/zeros/setup", "/srv/zeros/log", "/srv/zeros/state/workspaces", "/srv/zeros/home/agent",
                     "/srv/zeros/home/capture", "/opt/zeros/sessions", "/var/log", "/run/log/journal"):
            self.clear_directory(path)
        private = (".ssh", ".aws", ".azure", ".docker", ".kube", ".cache", ".local/state", ".local/share/keyrings", ".npm/_logs",
                   ".config/git/credentials", ".config/gh", ".config/gcloud", ".config/cursor", ".claude", ".codex", ".cursor",
                   ".git-credentials", ".netrc", ".npmrc", ".pypirc", ".bash_history", ".zsh_history", ".python_history", ".gitconfig")
        for home in ("/root", "/home/user"):
            for name in private:
                target = self.path(home + "/" + name)
                self.ancestry(target)
                self.remove(target)
            for target in self.path(home).glob(".env*"): self.remove(target)
        for path in ("/opt/zeros/disk-epoch", "/run/zeros/active-runtime.json", "/run/zeros/computer-build",
                     "/var/lib/systemd/random-seed", "/var/lib/systemd/timesync/clock"):
            target = self.path(path)
            self.ancestry(target)
            self.remove(target)
        machine = self.path("/etc/machine-id")
        if machine.exists():
            require(not machine.is_symlink(), "sanitation_failed")
            atomic(machine, b"", 0o444)
        dbus_machine = self.path("/var/lib/dbus/machine-id")
        if dbus_machine.exists() and not dbus_machine.is_symlink(): atomic(dbus_machine, b"", 0o444)
        # Runtime receipts and provider-managed OS SSH identity are retained:
        # bootstrap and Boat own their next-boot validation/regeneration.
        directory = self.directory("/srv/zeros")
        atomic(directory / "computer-template.json", packed(manifest), 0o444)
        os.sync()
        return {"schema": "zeros.computer-sanitation/v1", "buildId": value["buildId"], "clean": True, "manifestSha256": value["manifestSha256"]}


def main():
    stage, code, checks = "validate_input", 1, ["input_schema"]
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 2)
        stages = {"clone-repos": "repositories", "run-install": "install", "verify-tcb": "integrity", "sanitize": "sanitation"}
        require(sys.argv[1] in stages)
        stage = stages[sys.argv[1]]
        os.umask(0o077)
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        require(len(raw) <= MAX_INPUT, "input_too_large")
        value = strict_json(raw)
        method = getattr(ComputerBuild(), sys.argv[1].replace("-", "_"))
        result = method(value)
        print(packed(result).decode(), flush=True)
        code, checks = 0, []
    except Failure as error:
        checks = ["tcb_modified" if stage == "integrity" else error.check]
    except BaseException:
        checks = ["tcb_modified" if stage == "integrity" else "helper_failed"]
    print(packed({"schema": "zeros.diagnostic/v1", "component": "build", "stage": stage, "ok": code == 0,
                  "exitCode": code, "timedOut": False, "failedChecks": checks}).decode(), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
