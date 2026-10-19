"""Consume the TypeScript producer's archive through the real slim-base gates.

Only the rootless host/mount fixture and final exec are substituted. In
particular, ComputerBuild imports the shipped bootstrap, with no verifier stub.
"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
from unittest import mock

sys.dont_write_bytecode = True
from test_bootstrap import BootstrapTests, HERE, b, canonical, digest


def verify(archive, descriptor, rejected=None):
    case = BootstrapTests()
    case.setUp()
    mount_patch = None
    try:
        base = case.root / "opt/zeros-bootstrap"
        source = (HERE.parent / "bootstrap.py").read_bytes()
        (base / "bootstrap.py").write_bytes(source)
        (base / "bootstrap.py").chmod(0o555)
        compatibility = json.loads((base / "compatibility.json").read_bytes())
        compatibility["protectedFiles"].append({"path": "/opt/zeros-bootstrap/bootstrap.py",
                                               "mode": "0555", "sha256": digest(source)})
        (base / "compatibility.json").chmod(0o644)
        (base / "compatibility.json").write_bytes(canonical(compatibility))
        (base / "compatibility.json").chmod(0o444)
        case.payload = Path(archive).read_bytes()
        case.value["runtime"] = json.loads(Path(descriptor).read_bytes())
        if rejected:
            case.reject(rejected)
            return {"rejected": rejected}
        case.install()
        runtime_id = case.value["runtime"]["runtimeId"]
        # The root launcher derives native Git helper links next to the hashed
        # runtime. Their presence must not change receipts, the cached-install
        # contract, dispatch or the Computer consumer's full verification.
        git_exec = case.root / "opt/zeros-infra/.git-exec" / runtime_id
        git_exec.mkdir(parents=True)
        (git_exec / "git-lfs").symlink_to(case.runtime() / "bin/git-lfs")
        git_exec.chmod(0o555)
        manifest, _ = case.app.verify_runtime(runtime_id, full=True, descriptor=case.value["runtime"])
        case.install()
        case.assertEqual(case.downloads, 1, "a cached install must verify the existing tree")
        case.assert_fresh_dispatch(runtime_id)
        case.assert_fresh_dispatch(runtime_id, boot=True)
        root = case.runtime()
        assets = json.loads((root / "worker/runtime-system-assets.json").read_bytes())
        case.assertEqual(assets["schema"], "zeros.runtime-system-assets/v1")
        case.assertEqual({p["name"] for p in assets["packages"]}, b.SYSTEM_ASSET_PACKAGES)
        modes = {**b.SYSTEM_ASSET_FILES,
                 **{"lib/runtime-system-assets/" + name + "/copyright": "0444" for name in b.SYSTEM_ASSET_PACKAGES},
                 **{name: "0444" for name in assets["fonts"]}}
        entries = {entry["path"]: entry for entry in manifest["files"]}
        for name, mode in modes.items():
            case.assertEqual(entries[name]["type"], "file")
            case.assertEqual(entries[name]["mode"], mode)
            case.assertGreater(entries[name]["size"], 0)
            case.assertEqual(digest((root / name).read_bytes()), entries[name]["sha256"])

        spec = importlib.util.spec_from_file_location("computer_build", HERE.parent / "computer-build.py")
        computer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(computer)
        original_execute = importlib.machinery.SourceFileLoader.exec_module

        def execute_with_fixture_mounts(loader, module):
            original_execute(loader, module)
            if Path(loader.path) == base / "bootstrap.py":
                # ComputerBuild reloads the exact shipped helper. Supply the
                # same temporary-root mount model without replacing a verifier.
                module.BindMounts = lambda: case.mounts

        mount_patch = mock.patch.object(importlib.machinery.SourceFileLoader, "exec_module", execute_with_fixture_mounts)
        mount_patch.start()
        builder = computer.ComputerBuild(case.root, uid=os.getuid(), gid=os.getgid())
        environment = builder.install_environment()
        case.assertEqual(environment, {**computer.ENVIRONMENT,
            "PATH": str(root / "bin") + ":" + computer.ENVIRONMENT["PATH"],
            "GIT_CONFIG_SYSTEM": str(root / "worker/gitconfig"),
            "FONTCONFIG_FILE": str(root / "worker/design-fonts/fonts.conf"),
            "FONTCONFIG_PATH": str(root / "worker/design-fonts")})

        # Same-length substitutions keep modes and inventory unchanged. The
        # actual dispatch must reject each selector before reaching execve.
        dispatch_rehashed = []
        full_rehashed = [*b.SYSTEM_ASSET_FILES, assets["fonts"][0],
                         "lib/runtime-system-assets/git-lfs/copyright"]
        for name in full_rehashed:
            target = root / name
            original = target.read_bytes()
            mode = int(entries[name]["mode"], 8)
            target.chmod(mode | 0o200)
            try:
                target.write_bytes(bytes([original[0] ^ 1]) + original[1:])
                target.chmod(mode)
                with case.assertRaises(b.Failure) as error:
                    case.app.verify_runtime(runtime_id, full=True)
                case.assertEqual(error.exception.checks, ["file_digest"])
                with case.assertRaises(computer.Failure) as error:
                    builder.install_environment()
                case.assertEqual(error.exception.check, "tcb_modified")
                if name in b.SYSTEM_ASSET_FILES:
                    with mock.patch.object(b.os, "execve") as execute, case.assertRaises(b.Failure) as error:
                        case.app.dispatch()
                    case.assertEqual(error.exception.checks, ["file_digest"])
                    execute.assert_not_called()
                    dispatch_rehashed.append(name)
            finally:
                target.chmod(mode | 0o200)
                target.write_bytes(original)
                target.chmod(mode)
        case.app.verify_runtime(runtime_id, full=True)
        case.assertEqual(builder.install_environment(), environment)
        return {"installed": True, "cached": True, "fullVerified": True, "dispatched": True,
                "derivedGitExecExcluded": True,
                "bootDispatched": True, "computerEnvironment": True, "packages": len(assets["packages"]),
                "fonts": len(assets["fonts"]), "copyrights": len(b.SYSTEM_ASSET_PACKAGES),
                "dispatchRehashed": dispatch_rehashed, "fullRehashed": full_rehashed}
    finally:
        if mount_patch is not None:
            mount_patch.stop()
        case.tearDown()


if __name__ == "__main__":
    # Fixture diagnostics are not the helper's machine-readable result.
    with contextlib.redirect_stdout(io.StringIO()):
        result = verify(*sys.argv[1:])
    print(json.dumps(result, sort_keys=True))
