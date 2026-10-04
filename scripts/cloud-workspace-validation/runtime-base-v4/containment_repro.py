"""Operator-only, credential-free probe; never installed in a base or runtime.

The fixed self-test runs first. Its layout preparation is left intact so the
second invocation uses exactly the same launcher, user, cwd and network setup.
No runtime file is patched and no containment condition is relaxed.
"""
import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time


def redact(value, maximum=2000):
    text = str(value)
    for expression, replacement in (
        (r'https?://[^\s<>"\']+', "[url]"),
        (r'(?i)\bBearer\s+[^\s"\']+', "[authorization]"),
        (r'\b(?:ghs_|gho_|ghp_|ghu_|github_pat_|condw_|sk_|sk-)[A-Za-z0-9_-]+', "[token]"),
        (r'\b[A-Z_][A-Z0-9_]*\s*=\s*(?:"[^"\n]*"|\'[^\'\n]*\'|[^\s,;]+)', "[assignment]"),
        (r'\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', "[jwt]"),
        (r'\b[a-fA-F0-9]{32,}\b', "[hex]"),
        (r'[A-Za-z0-9+/_-]{48,}={0,2}', "[opaque]"),
        (r'\b(?:curl|wget)\b', "download-tool"),
    ):
        text = re.sub(expression, replacement, text)
    return text[-maximum:]


def capture(command, environment, timeout, maximum=8 * 1024 * 1024):
    """Bound both pipes; retire the launcher's scope on timeout before SIGKILL."""
    child = subprocess.Popen(command, cwd="/", env=environment, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, "stdout")
    selector.register(child.stderr, selectors.EVENT_READ, "stderr")
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": maximum, "stderr": 65536}
    deadline = time.monotonic() + timeout
    timed_out = False
    output_limit = False
    terminate_at = None
    try:
        while selector.get_map() or child.poll() is None:
            now = time.monotonic()
            timed_out |= now >= deadline
            if (timed_out or output_limit) and terminate_at is None:
                terminate_at = now
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if terminate_at is not None and now - terminate_at >= 15:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                # A detached descendant may retain a pipe outside this process
                # group. The VM is deleted by the caller; never wait forever.
                break
            for key, _ in selector.select(0.1):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                room = limits[key.data] - len(buffers[key.data])
                output_limit |= len(data) > room
                buffers[key.data].extend(data[:room])
        return {"exitCode": child.wait(), "timedOut": timed_out, "outputLimit": output_limit,
                **{key: bytes(data).decode("utf8", "replace") for key, data in buffers.items()}}
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        selector.close()
        child.stdout.close()
        child.stderr.close()


def summarize(value):
    if not isinstance(value, dict):
        return None
    result = {"version": value.get("version"), "secure": value.get("secure") is True}
    for name in ("identity", "workload", "capture", "humanServices", "actorTools"):
        section = value.get(name)
        if not isinstance(section, dict):
            result[name] = None
            continue
        selected = {"secure": section.get("secure") is True}
        for field in ("error", "phase", "failureCode", "signal"):
            if isinstance(section.get(field), str):
                selected[field] = redact(section[field])
        for field in ("exitCode", "hostUid", "namespaceUid", "noNewPrivs", "seccompMode"):
            if isinstance(section.get(field), int):
                selected[field] = section[field]
        checks = section.get("checks")
        if isinstance(checks, list):
            selected["checks"] = []
            for item in checks[:128]:
                if isinstance(item, str):
                    selected["checks"].append(redact(item, 200))
                elif isinstance(item, dict):
                    selected["checks"].append({key: redact(item[key]) for key in ("name", "status", "detail")
                                               if isinstance(item.get(key), str)})
        if name == "identity" and isinstance(section.get("resources"), dict):
            selected["resources"] = {key: text if text is None or isinstance(text, bool) else redact(text)
                                      for key, text in section["resources"].items()
                                      if key in ("finite", "memoryMax", "pidsMax", "cpuMax")}
        result[name] = selected
    return result


def qualify(root, home, detailed):
    node = root + "/bin/node"
    launcher = root + "/lib/zeros/cloud-engine-launcher.mjs"
    args = [node, launcher, "--qualify"]
    if detailed:
        # The CLI intentionally hides rejected-launch errors. Invoke the SAME
        # exported launcher and scope implementation, preserving every check.
        source = ("import {launchCloudEngine} from " + json.dumps(launcher) + ";"
                  "try{process.exitCode=await launchCloudEngine({operation:'qualify'});}"
                  "catch(e){console.error(e.stack??e.name);process.exitCode=125;}")
        args = [node, "--input-type=module", "-e", source]
    code = ("import os,socket,fcntl,struct; "
            "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); "
            "fcntl.ioctl(s,0x8914,struct.pack('16sH14x',b'lo',1)); s.close(); "
            "os.execve(" + repr(node) + "," + repr(args) + ",dict(os.environ))")
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": home, "TMPDIR": home}
    child = capture(["/usr/bin/unshare", "--net", "--", "/usr/bin/python3", "-I", "-c", code], environment, 330)
    report = None
    try:
        report = summarize(json.loads(child["stdout"]))
    except (ValueError, TypeError):
        pass
    return {**{key: child.get(key) for key in ("exitCode", "timedOut", "outputLimit")}, "report": report,
            "stderr": redact(child["stderr"]),
            "stdoutTail": redact(child["stdout"]) if report is None else None}


def read_fixed(file, maximum=4096):
    try:
        with open(file, "rb") as source:
            return redact(source.read(maximum).decode("utf8", "replace"), maximum)
    except OSError as error:
        return {"error": type(error).__name__, "errno": error.errno}


def metadata(file):
    try:
        info = os.lstat(file)
        result = {"uid": info.st_uid, "gid": info.st_gid, "mode": oct(stat.S_IMODE(info.st_mode)),
                  "directory": stat.S_ISDIR(info.st_mode), "symlink": stat.S_ISLNK(info.st_mode), "nlink": info.st_nlink}
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(file) as entries:
                result["children"] = [redact(entry.name, 100) for _, entry in zip(range(32), entries)]
        return result
    except OSError as error:
        return {"error": type(error).__name__, "errno": error.errno}


def host(root):
    environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
    result = {"uid": os.getuid(), "gid": os.getgid(), "kernel": os.uname().release}
    result["kernelFiles"] = {file: read_fixed(file) for file in (
        "/proc/self/uid_map", "/proc/self/gid_map", "/proc/self/cgroup", "/proc/self/attr/current",
        "/proc/sys/kernel/overflowuid", "/proc/sys/kernel/overflowgid",
        "/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/user/max_user_namespaces",
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "/sys/module/apparmor/parameters/enabled")}
    profiles = read_fixed("/sys/kernel/security/apparmor/profiles", 65536)
    result["apparmorProfiles"] = [line for line in profiles.splitlines() if "zeros" in line or "bwrap" in line] if isinstance(profiles, str) else profiles
    paths = ["/opt", "/opt/zeros-infra", root, root + "/bin/node", root + "/libexec/cloud-engine-namespace",
             "/usr", "/usr/local", "/usr/bin/bwrap", "/usr/bin/setpriv", "/usr/bin/rg", "/etc/zeros",
             "/etc/apparmor.d/zeros-cloud-engine", "/etc/containers/policy.json", "/etc/containers/registries.conf",
             "/srv/zeros", "/srv/zeros/files", "/srv/zeros/files/workspace", "/srv/zeros/files/repos",
             "/srv/zeros/files/.zeros-setup", "/srv/zeros/files/home", "/srv/zeros/state", "/srv/zeros/home",
             "/srv/zeros/home/agent", "/srv/zeros/home/capture", "/srv/zeros/managed-settings", "/run/zeros", "/run/zeros/engine"]
    result["paths"] = {file.replace(root, "R"): metadata(file) for file in paths}
    cgroup = "/sys/fs/cgroup/system.slice/zeros-host.service"
    result["cgroup"] = {leaf + "/" + control: read_fixed(cgroup + leaf + "/" + control) for leaf in ("", "/host")
                        for control in ("cgroup.controllers", "cgroup.subtree_control", "cgroup.type", "cpu.max", "memory.max", "pids.max")}
    result["mounts"] = []
    with open("/proc/self/mountinfo", encoding="utf8") as source:
        for line in source:
            columns = line.split()
            if len(columns) < 7 or "-" not in columns:
                continue
            target = columns[4]
            if target == "/" or target.startswith(("/srv/zeros", "/home/user", "/opt", "/usr", "/sys/fs/cgroup")):
                result["mounts"].append({"target": redact(target), "root": redact(columns[3]), "device": columns[2],
                                         "options": columns[5], "fs": columns[columns.index("-") + 1]})
            if len(result["mounts"]) >= 64:
                break
    for name, command in (
        ("units", ["/usr/bin/systemctl", "show", "-p", "ActiveState", "-p", "SubState", "-p", "Result", "-p", "ExecMainStatus", "zeros-boot", "zeros-host"]),
        ("bwrap", ["/usr/bin/bwrap", "--ro-bind", "/", "/", "--unshare-user", "--unshare-pid", "--proc", "/proc", "--", "/usr/bin/true"]),
    ):
        child = capture(command, environment, 10, maximum=65536)
        result[name] = {**child, "stdout": redact(child["stdout"]), "stderr": redact(child["stderr"])}
    return result


def main(mode, runtime_id):
    directory = None
    try:
        assert os.getuid() == 0 and os.geteuid() == 0
        assert re.fullmatch(r"r1-[a-f0-9]{64}", runtime_id)
        root = "/opt/zeros-infra/" + runtime_id
        if mode == "host":
            result = host(root)
        else:
            assert mode in ("qualify", "launch_detail")
            directory = tempfile.mkdtemp(prefix="runtime-smoke-", dir="/run/zeros")
            result = qualify(root, directory, mode == "launch_detail")
        print(json.dumps({"mode": mode, **result}), flush=True)
    except Exception as error:
        frames = []
        trace = error.__traceback__
        while trace:
            frames.append({"function": trace.tb_frame.f_code.co_name, "line": trace.tb_lineno})
            trace = trace.tb_next
        print(json.dumps({"mode": mode, "error": type(error).__name__, "errno": getattr(error, "errno", None), "sites": frames[-4:]}), flush=True)
    finally:
        if directory:
            shutil.rmtree(directory)
