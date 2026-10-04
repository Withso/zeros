"""Operator-only live-check payload; not installed in the base or runtime.

The kit invokes main with a fixed phase over Boat exec. The same directory
operations run in local tests. Only closed checks, boolean/count evidence and
failure class/line identities leave the VM; paths, machine IDs and messages do not.
"""
import importlib.util
import json
import os
import stat
import sys


class AgentProbeFailure(Exception):
    def __init__(self, evidence):
        super().__init__("Agent probe failed")
        self.evidence = evidence


def probe_failure(error):
    if isinstance(error, AgentProbeFailure):
        return error.evidence
    names = {"AssertionError", "Failure", "FileNotFoundError", "PermissionError", "OSError", "TimeoutError",
             "TimeoutExpired", "CalledProcessError", "ValueError", "TypeError", "KeyError", "RuntimeError", "JSONDecodeError",
             "NotADirectoryError", "IsADirectoryError", "FileExistsError", "BlockingIOError", "InterruptedError", "BrokenPipeError"}
    name = type(error).__name__
    line, trace = 0, error.__traceback__
    while trace is not None:
        if trace.tb_frame.f_code.co_filename == __file__:
            line = trace.tb_lineno
        trace = trace.tb_next
    return {"schema": "zeros.live-probe-failure/v1", "exception": name if name in names else "Exception", "line": line}


def tree_operation(phase, root):
    assert phase in ("seed", "rename", "verify")
    pairs = (("same_parent", "same-before", "same-after"), ("cross_parent", "from/move-before", "into/move-after"))
    control = root / "untouched/nested/seed.txt"
    if phase == "seed":
        control.parent.mkdir(parents=True)
        control.write_bytes(b"unrenamed seed data\n")
        (root / "into").mkdir()
        for _, before, _ in pairs:
            (root / before / "nested").mkdir(parents=True)
            (root / before / "nested/before.txt").write_text("from the previous session\n")
        assert control.read_bytes() == b"unrenamed seed data\n"
        return
    # A rename-specific exception must never hide loss of untouched seed data.
    assert control.read_bytes() == b"unrenamed seed data\n"
    if phase == "rename":
        for _, before, after in pairs:
            assert (root / before / "nested/before.txt").read_text() == "from the previous session\n"
            assert not os.path.lexists(root / after)
            (root / before).rename(root / after)
            (root / after / "after.txt").write_text("written after rename\n")

    def matches(file, expected):
        try:
            return file.read_bytes() == expected
        except FileNotFoundError:
            return False  # Known Boat restore behavior, only for renamed trees.

    checks = {}
    for name, before, after in pairs:
        checks[name + "_old_absent"] = not os.path.lexists(root / before)
        checks[name + "_seed_intact"] = matches(root / after / "nested/before.txt", b"from the previous session\n")
        checks[name + "_new_intact"] = matches(root / after / "after.txt", b"written after rename\n")
    if phase == "rename":
        assert all(checks.values())  # Immediate rename behavior stays mandatory.
    return checks  # Post-resume failures are recorded by the kit as a known issue.


def as_agent(uid, gid, phase, root):
    if (os.getuid(), os.getgid()) == (uid, gid):
        return tree_operation(phase, root)  # Rootless test adapter.
    reader, writer = os.pipe()
    try:
        pid = os.fork()
        if pid == 0:
            os.close(reader)
            try:
                os.setgroups([])
                os.setgid(gid)
                os.setuid(uid)
                result = tree_operation(phase, root)
                os.write(writer, json.dumps(result).encode())
            except BaseException as error:
                try:
                    # Fixed identities only, well below PIPE_BUF; no child
                    # paths, messages or traceback text cross this boundary.
                    os.write(writer, json.dumps(probe_failure(error)).encode())
                finally:
                    os._exit(1)
            os._exit(0)
        os.close(writer)
        writer = None
        _, status = os.waitpid(pid, 0)
        evidence = os.read(reader, 512)
        result = json.loads(evidence) if evidence else None
        if isinstance(result, dict) and result.get("schema") == "zeros.live-probe-failure/v1":
            raise AgentProbeFailure(result)
        assert os.waitstatus_to_exitcode(status) == 0
        return result
    finally:
        os.close(reader)
        if writer is not None:
            os.close(writer)


def probe(app, phase):
    assert phase in ("cold", "seed", "rename", "verify")
    # This waits for the enabled units. Do not repair/start them in the probe.
    app.wait_ready()
    app.base()
    record = app.persistence()
    aliases = [app.path(name).stat() for name in ("/srv/zeros/files/repos", "/srv/zeros/repos")]
    assert (aliases[0].st_dev, aliases[0].st_ino) == (aliases[1].st_dev, aliases[1].st_ino)
    assert len(record["mounts"]) == 4
    table = app.mounts.table()
    filesystems = []
    for entry in record["mounts"]:
        mounts = [mount for mount in table if mount["target"] == str(app.path(entry["target"]))]
        assert len(mounts) == 1
        filesystems.append(mounts[0]["filesystem"])
    assert len(set(filesystems)) == 1
    residue = json.loads(app.read("/run/zeros/persistence-residue.json", 4096, 0o600))
    assert residue["schema"] == "zeros.persistence-residue/v1" and residue["bootId"] == record["bootId"]
    counts = [residue[key] for key in ("directories", "files", "symlinks", "other")]
    assert all(type(count) is int and 0 <= count <= 2**53 - 1 for count in counts)
    entries = sum(counts)
    mounts = residue["mountPoints"]
    assert type(mounts) is int and 0 <= mounts <= 4 and bool(entries) == bool(mounts)
    if phase in ("rename", "verify"):
        # Both stops deliberately keep all binds active. Boot must acknowledge
        # clearing capture residue on this restore, not just hide it by binding.
        assert entries > 0 and mounts > 0
    rename_checks = None
    if phase != "cold":
        root = app.path("/srv/zeros/files/zeros-v2-test-persistence")
        uid, gid = app.account("agent")
        if phase == "seed":
            root.mkdir(mode=0o700)  # Refuse a pre-existing probe directory.
            os.chown(root, uid, gid, follow_symlinks=False)
        metadata = root.lstat()
        assert stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
        assert (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) == (uid, gid, 0o700)
        rename_checks = as_agent(uid, gid, phase, root)
    if phase == "seed":
        # Model C3's sanitized template identity. The next restore must fill
        # this without relying on stock early-boot services having run again.
        app.atomic("/etc/machine-id", b"", 0o444)
    os.sync()
    return {"schema": "zeros.persistence-probe/v1", "phase": phase, "bindCount": 4, "repoAliases": True,
            "bindFilesystem": filesystems[0],
            "hostReady": True, "residueCleared": entries > 0, "residueEntries": entries, "residueMounts": mounts,
            "machineIdPresent": phase != "seed", "templateIdentityCleared": phase == "seed",
            "seedDataIntact": phase != "cold", "renameChecks": rename_checks,
            "renames": 2 if phase in ("rename", "verify") else 0,
            "oldPathsAbsent": rename_checks is not None and rename_checks["same_parent_old_absent"] and rename_checks["cross_parent_old_absent"]}


def main(phase):
    sys.dont_write_bytecode = True
    code = 1
    app = None
    try:
        spec = importlib.util.spec_from_file_location("bootstrap", "/opt/zeros-bootstrap/bootstrap.py")
        bootstrap = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bootstrap)
        app = bootstrap.Bootstrap()
        result = probe(app, phase)
        assert result["bindFilesystem"] == "ext4"  # Boat must have retired ascii-lazyfs.
        print(json.dumps(result, separators=(",", ":")), flush=True)
        code = 0
    except BaseException as error:
        if app is not None:
            try:
                app.log_failure(error, stage="resume")
            except BaseException:
                pass  # Preserve the original probe failure even without a VM log.
        print(json.dumps(probe_failure(error)), flush=True)
    print(json.dumps({"schema": "zeros.diagnostic/v1", "component": "base", "stage": "resume", "ok": code == 0,
                      "exitCode": code, "timedOut": False, "failedChecks": [] if code == 0 else ["base_compatibility"]},
                     separators=(",", ":")), flush=True)
    sys.exit(code)
