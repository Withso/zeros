"""Operator-only containment diagnostic copied from B4's containment_repro.py.

Keep B4's private network, loopback setup, minimal environment, bounded pipes,
and scope retirement. The launch_detail catch emits a closed identity instead
of a stack. This file is copied only into the disposable fork's private /run.
"""
import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def redact(value, maximum=2000):
    text = str(value)
    for expression, replacement in (
        (r'\b[A-Za-z][A-Za-z0-9+.-]*://[^\s<>"\']+', "[url]"),
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


def qualify(root, home, detailed, probe_file, timeout):
    node = root + "/bin/node"
    launcher = root + "/lib/zeros/cloud-engine-launcher.mjs"
    args = [node, launcher, "--qualify"]
    if detailed:
        # Use the same exported launcher and scope. No error stack or arbitrary
        # message can leave the child; the probe owns the closed projection.
        source = ("import {sanitizeLauncherError} from " + json.dumps(probe_file) + ";"
                  "try{const {launchCloudEngine}=await import(" + json.dumps(launcher) + ");"
                  "process.exitCode=await launchCloudEngine({operation:'qualify'});}"
                  "catch(e){console.error(JSON.stringify({schema:'zeros.template-setup-launcher-error/v1',"
                  "...sanitizeLauncherError(e)}));process.exitCode=125;}")
        args = [node, "--input-type=module", "-e", source]
    code = ("import os,socket,fcntl,struct; "
            "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); "
            "fcntl.ioctl(s,0x8914,struct.pack('16sH14x',b'lo',1)); s.close(); "
            "os.execve(" + repr(node) + "," + repr(args) + ",dict(os.environ))")
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": home, "TMPDIR": home}
    child = capture(["/usr/bin/unshare", "--net", "--", "/usr/bin/python3", "-I", "-c", code], environment, timeout)
    report = None
    try:
        report = summarize(json.loads(child["stdout"]))
    except (ValueError, TypeError):
        pass
    result = {**{key: child.get(key) for key in ("exitCode", "timedOut", "outputLimit")}, "report": report}
    # Unknown stdout/stderr is never printed. Only the launch_detail catch's
    # structured, already closed error is eligible for the final report.
    for line in child["stderr"].splitlines()[-4:]:
        try:
            detail = json.loads(line)
            if isinstance(detail, dict) and detail.get("schema") == "zeros.template-setup-launcher-error/v1":
                result["launcherError"] = {key: detail[key] for key in ("name", "message", "code") if isinstance(detail.get(key), str)}
        except (ValueError, TypeError):
            pass
    return result


def main():
    directory = None
    try:
        assert os.getuid() == 0 and os.geteuid() == 0
        root, probe_file, mode, timeout_text = sys.argv[1:]
        assert re.fullmatch(r"/opt/zeros-infra/r1-[a-f0-9]{64}", root)
        assert mode in ("qualify", "launch_detail")
        timeout = int(timeout_text)
        assert 1 <= timeout <= 330
        directory = tempfile.mkdtemp(prefix="zeros-v2-test-s1-qualify-", dir="/run/zeros")
        result = qualify(root, directory, mode == "launch_detail", probe_file, timeout)
        print(json.dumps(result, separators=(",", ":")), flush=True)
    except Exception as error:
        name = type(error).__name__
        if name not in ("OSError", "FileNotFoundError", "PermissionError", "ValueError", "AssertionError"):
            name = "UnknownError"
        print(json.dumps({"exitCode": 125, "timedOut": False, "outputLimit": False, "report": None,
                          "launcherError": {"name": name, "message": "<withheld>"}}, separators=(",", ":")), flush=True)
    finally:
        if directory:
            shutil.rmtree(directory)


if __name__ == "__main__":
    main()
