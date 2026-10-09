"""Pair actual runtime adoption metadata with the unchanged base reader.

Only descriptor ownership observations are modeled. The original base suite's
rootless filesystem/mount fixture remains authoritative; no sudo or chown.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
from unittest import mock

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("original_base_tests", root / "scripts/cloud-workspace-validation/runtime-base-v4/tests/test_bootstrap.py")
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)
metadata = json.load(sys.stdin)
fixture = original.BootstrapTests("test_empty_boot_status_and_facade")
fixture.setUp()
try:
    app = fixture.app
    app.accounts["agent"] = (10001, 10001)
    app.accounts["capture"] = (10002, 10002)
    real_fstat = os.fstat
    prefix = str(fixture.root)

    def observed(fd):
        value = real_fstat(fd)
        target = os.readlink(f"/proc/self/fd/{fd}")
        logical = target[len(prefix):] if target.startswith(prefix + "/") else None
        if logical and logical.startswith("/home/user/.zeros-persist/"):
            logical = "/srv/zeros/" + logical.removeprefix("/home/user/.zeros-persist/")
        if logical in metadata:
            entry = metadata[logical]
            fields = list(value)
            fields[0] = (value.st_mode & ~0o7777) | entry["mode"]
            fields[4] = app.uid if entry["uid"] == 0 else entry["uid"]
            fields[5] = app.gid if entry["gid"] == 0 else entry["gid"]
            return os.stat_result(fields)
        return value

    with mock.patch.object(original.b.os, "fstat", side_effect=observed):
        app.require_persistence()
        app.persistence(create=True)
        app.require_persistence()
    print(json.dumps({"requirePersistence": True, "coldCreate": True}))
finally:
    fixture.tearDown()
