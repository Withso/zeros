"""Operator-only live-check payload; not installed in the base or runtime.

The kit invokes main with a fixed phase over Boat exec. The same directory
operations run in local tests. Only closed checks and boolean/count evidence
leave the VM; paths, machine IDs and child errors stay private.
"""
import importlib.util
import json
import os
import stat
import sys


def tree_operation(phase, root):
    assert phase in ("seed", "rename", "verify")
    pairs = (("same-before", "same-after"), ("from/move-before", "into/move-after"))
    if phase == "seed":
        (root / "into").mkdir()
        for before, _ in pairs:
            (root / before / "nested").mkdir(parents=True)
            (root / before / "nested/before.txt").write_text("from the previous session\n")
        return
    if phase == "rename":
        for before, after in pairs:
            assert (root / before / "nested/before.txt").read_text() == "from the previous session\n"
            assert not os.path.lexists(root / after)
            (root / before).rename(root / after)
            (root / after / "after.txt").write_text("written after rename\n")
    for before, after in pairs:
        assert not os.path.lexists(root / before)
        assert (root / after / "nested/before.txt").read_text() == "from the previous session\n"
        assert (root / after / "after.txt").read_text() == "written after rename\n"


def as_agent(uid, gid, phase, root):
    if (os.getuid(), os.getgid()) == (uid, gid):
        tree_operation(phase, root)  # Rootless test adapter.
        return
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)
            tree_operation(phase, root)
        except BaseException:
            os._exit(1)
        os._exit(0)
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0


def probe(app, phase):
    assert phase in ("cold", "seed", "rename", "verify")
    # This waits for the enabled units. Do not repair/start them in the probe.
    app.wait_ready()
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
    if phase != "cold":
        root = app.path("/srv/zeros/files/zeros-v2-test-persistence")
        uid, gid = app.account("agent")
        if phase == "seed":
            root.mkdir(mode=0o700)  # Refuse a pre-existing probe directory.
            os.chown(root, uid, gid, follow_symlinks=False)
        metadata = root.lstat()
        assert stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
        assert (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) == (uid, gid, 0o700)
        as_agent(uid, gid, phase, root)
    if phase == "seed":
        # Model C3's sanitized template identity. The next restore must fill
        # this without relying on stock early-boot services having run again.
        app.atomic("/etc/machine-id", b"", 0o444)
    os.sync()
    return {"schema": "zeros.persistence-probe/v1", "phase": phase, "bindCount": 4, "repoAliases": True,
            "bindFilesystem": filesystems[0],
            "hostReady": True, "residueCleared": entries > 0, "residueEntries": entries, "residueMounts": mounts,
            "machineIdPresent": phase != "seed", "templateIdentityCleared": phase == "seed",
            "renames": 2 if phase in ("rename", "verify") else 0,
            "oldPathsAbsent": phase in ("rename", "verify")}


def main(phase):
    sys.dont_write_bytecode = True
    code = 1
    app = None
    try:
        spec = importlib.util.spec_from_file_location("bootstrap", "/opt/zeros-bootstrap/bootstrap.py")
        bootstrap = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bootstrap)
        app = bootstrap.Bootstrap()
        app.base()
        result = probe(app, phase)
        assert result["bindFilesystem"] == "ext4"  # Boat must have retired ascii-lazyfs.
        print(json.dumps(result, separators=(",", ":")), flush=True)
        code = 0
    except BaseException as error:
        if app is not None:
            app.log_failure(error, stage="resume")
    print(json.dumps({"schema": "zeros.diagnostic/v1", "component": "base", "stage": "resume", "ok": code == 0,
                      "exitCode": code, "timedOut": False, "failedChecks": [] if code == 0 else ["base_compatibility"]},
                     separators=(",", ":")), flush=True)
    sys.exit(code)
