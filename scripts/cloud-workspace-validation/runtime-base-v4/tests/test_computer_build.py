import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "computer-build.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("computer_build", SOURCE)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
JOB = {"buildId": "11111111-1111-4111-8111-111111111111", "workerFence": 7}
RUNTIME = "r1-" + "a" * 64
bootstrap_spec = importlib.util.spec_from_file_location("fixture_bootstrap", SOURCE.with_name("bootstrap.py"))
bootstrap = importlib.util.module_from_spec(bootstrap_spec)
bootstrap_spec.loader.exec_module(bootstrap)
mount_spec = importlib.util.spec_from_file_location("computer_native_mounts", Path(__file__).with_name("mount_fixture.py"))
mount_fixture = importlib.util.module_from_spec(mount_spec)
mount_spec.loader.exec_module(mount_fixture)


class Logs(unittest.TestCase):
    def test_literal_redaction_at_every_boundary_and_end(self):
        secret = "synthetic-clone-credential"
        for split in range(1, len(secret)):
            redact = build.LogFilter([secret])
            output = redact.push("stdout", "before " + secret[:split])
            output += redact.push("stdout", secret[split:] + "\nafter\n") + redact.finish("stdout")
            self.assertEqual(output, "before [redacted]\nafter\n")
        redact = build.LogFilter([secret])
        self.assertEqual(redact.push("stdout", "synthetic-clo") + redact.finish("stdout"), "[redacted]")

    def test_shapes_controls_and_unbounded_line(self):
        redact = build.LogFilter([])
        token = "ghs_" + "fixture" * 8
        output = redact.push("stderr", "\x1b[31mAuthorization: Bea") + redact.push("stderr", "rer " + token + "\n")
        self.assertNotIn(token, output)
        self.assertNotIn("\x1b", output)
        output = redact.push("stdout", "x" * 2_000_000) + redact.push("stdout", "\nnext\n")
        self.assertLess(len(output.encode()), 9000)
        self.assertIn("truncated", output)
        self.assertIn("next\n", output)

    def test_escape_removal_cannot_reconstruct_a_known_literal(self):
        redact = build.LogFilter(["synthetic-credential"])
        output = redact.push("stdout", "synthetic-\x1b[31mcredential\x1b[0m\n")
        self.assertNotIn("synthetic-credential", output)

    def test_spool_is_one_mib_and_cursor_is_monotonic(self):
        with tempfile.TemporaryDirectory() as root:
            spool = build.InstallStore(Path(root), JOB)
            spool.initialize("fixture-input-digest")
            for i in range(180):
                spool.append("stdout", "é" * 4096)
            status = spool.status(0)
            self.assertTrue(status["truncated"])
            self.assertLessEqual(sum(len(row["text"].encode()) for row in spool.read()["chunks"]), 1_048_576)
            self.assertLessEqual(len(status["chunks"]), 8)
            self.assertGreater(status["nextAfter"], 1)
            self.assertGreater(spool.status(status["nextAfter"])["chunks"][0]["seq"], status["nextAfter"])


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o755)
        self.app = build.ComputerBuild(self.root, uid=os.getuid(), gid=os.getgid(), repo_uid=os.getuid(), repo_gid=os.getgid())
        # A base-owned bootstrap double verifies its call contract. The B4
        # inventory/extraction suites separately verify the bootstrap itself.
        self.write("/opt/zeros-bootstrap/bootstrap.py", """import importlib.util
spec = importlib.util.spec_from_file_location('fixture_bootstrap', """ + repr(str(SOURCE.with_name("bootstrap.py"))) + """)
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
mount_spec = importlib.util.spec_from_file_location('native_mounts', """ + repr(str(Path(__file__).with_name("mount_fixture.py"))) + """)
mounts = importlib.util.module_from_spec(mount_spec)
mount_spec.loader.exec_module(mounts)
Failure = source.Failure
class Bootstrap(source.Bootstrap):
    def base(self):
        self.mounts = mounts.NativeMounts(self.root)
        stock = source.strict_json(self.read('/opt/zeros-bootstrap/stock-prerequisites.json', 131072, 0o444), 'base_compatibility')
        self.optional_systemd_policy = stock['optionalSystemd']
        self.optional_systemd = self.optional_systemd_absence(self.optional_systemd_policy)
    def current(self): return '""" + RUNTIME + """'
    def verify_runtime(self, runtime_id, full=True):
        assert runtime_id == '""" + RUNTIME + """' and full
        return {}, b'fixture-receipt'
""", 0o555)
        self.write("/opt/zeros-bootstrap/computer-build.py", SOURCE.read_text(), 0o555)
        self.write("/opt/zeros-bootstrap/computer-git-askpass.py", "base-owned askpass", 0o555)
        self.write("/etc/systemd/system/zeros-host.service", "[Service]\nExecStart=/opt/zeros-bootstrap/dispatch.sh\n", 0o444)
        self.write("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\nagent:x:10001:10001::/srv/zeros/home/agent:/bin/bash\n")
        self.write("/etc/group", "root:x:0:\nagent:x:10001:\n")
        self.write("/etc/subuid", "zeros-agent:100000:65536\n")
        self.write("/etc/subgid", "zeros-agent:100000:65536\n")
        self.write("/etc/sudoers", "root ALL=(ALL) ALL\n", 0o440)
        self.write("/etc/apparmor.d/zeros-cloud-engine", "fixture profile", 0o444)
        self.write("/opt/zeros-infra/" + RUNTIME + "/fixture", "verified runtime", 0o444)
        self.mkdir("/opt/zeros")
        self.mkdir("/opt/zeros/sessions").chmod(0o700)
        (self.root / "opt/zeros/current").symlink_to("../zeros-infra/" + RUNTIME)
        self.mkdir("/usr/local/lib")
        stock = {"optionalSystemd": self.optional_policy()}
        self.write("/opt/zeros-bootstrap/stock-prerequisites.json", build.packed(stock), 0o444)
        protected = []
        for path in ("/opt/zeros-bootstrap/bootstrap.py", "/opt/zeros-bootstrap/computer-build.py", "/opt/zeros-bootstrap/computer-git-askpass.py", "/opt/zeros-bootstrap/stock-prerequisites.json", "/etc/systemd/system/zeros-host.service"):
            value = self.root / path.lstrip("/")
            protected.append({"path": path, "mode": format(value.stat().st_mode & 0o7777, "04o"), "sha256": build.sha(value.read_bytes())})
        contract = {"schema": "zeros.base-compatibility/v1", "protectedFiles": protected, "uids": {"agent": 10001, "capture": 10002, "engine": 10003, "coordinator": 10004}}
        raw = build.packed(contract)
        self.write("/opt/zeros-bootstrap/compatibility.json", raw, 0o444)
        self.compatibility = "bc1-" + build.sha(raw)
        self.tcb = {"schema": "zeros.computer-tcb-input/v1", **JOB, "runtimeId": RUNTIME, "baseCompatibilityId": self.compatibility, "action": "baseline"}

    def tearDown(self):
        self.temp.cleanup()

    def optional_policy(self):
        app = bootstrap.Bootstrap(self.root, uid=os.getuid(), gid=os.getgid())
        app.mounts = mount_fixture.NativeMounts(self.root)
        return app.qualify_optional_systemd({"uid": 4242, "gid": 4242})

    def mkdir(self, path):
        value = self.root / path.lstrip("/")
        value.mkdir(parents=True, exist_ok=True)
        return value

    def write(self, path, text, mode=0o644):
        value = self.root / path.lstrip("/")
        value.parent.mkdir(parents=True, exist_ok=True)
        # Fixtures include read-only protected files. Replace through the owned
        # parent so tampering tests also exercise verification without root.
        if value.exists() or value.is_symlink():
            value.unlink()
        value.write_bytes(text.encode() if isinstance(text, str) else text)
        value.chmod(mode)
        return value

    def baseline(self):
        return self.app.verify_tcb(self.tcb)["protectedContractDigest"]

    def verify(self, digest):
        return self.app.verify_tcb({**self.tcb, "action": "verify", "protectedContractDigest": digest})

    def recipe_environment(self):
        # Exercise install-shell's final exec environment without root or a
        # mount. Bootstrap still selects and verifies the synthetic runtime.
        self.mkdir("/run/zeros")
        target = self.mkdir("/srv/zeros/repos")
        app = build.ComputerBuild()
        readlink = os.readlink
        def namespace(path, *args, **kwargs):
            if path == "/proc/self/ns/mnt": return "private"
            if path == "/proc/1/ns/mnt": return "host"
            return readlink(path, *args, **kwargs)
        with patch.object(app, "path", side_effect=self.app.path), \
             patch.object(app, "repository_parent", return_value=target), \
             patch.object(app, "install_environment", wraps=self.app.install_environment), \
             patch.object(build.os, "geteuid", return_value=0), \
             patch.object(build.os, "readlink", side_effect=namespace), \
             patch.object(build, "bounded_command", return_value=(0, b"")), \
             patch.object(build.os, "chdir"), patch.object(build.os, "execve") as execute:
            app.install_shell()
        executable, arguments, environment = execute.call_args.args
        self.assertEqual(executable, "/usr/bin/bash")
        self.assertEqual(arguments, ["/usr/bin/bash", "-euo", "pipefail"])
        return environment

    def test_recipe_exec_resolves_verified_physical_lfs_and_font_configuration(self):
        runtime = self.root / "opt/zeros-infra" / RUNTIME
        # This executable proves resolution, not Git LFS functionality.
        self.write("/opt/zeros-infra/" + RUNTIME + "/bin/git-lfs", "#!/bin/sh\nprintf 'fixture-lfs\\n'\n", 0o555)
        git_config = self.write("/opt/zeros-infra/" + RUNTIME + "/worker/gitconfig", '[filter "lfs"]\n\tprocess = git-lfs filter-process\n', 0o444)
        font_config = self.write("/opt/zeros-infra/" + RUNTIME + "/worker/design-fonts/fonts.conf", '<fontconfig><dir prefix="relative">.</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>', 0o444)
        with patch.dict(os.environ, {"PATH": "/untrusted", "GIT_CONFIG_SYSTEM": "/untrusted", "FONTCONFIG_FILE": "/untrusted"}):
            environment = self.recipe_environment()
        self.assertEqual(environment, {**build.ENVIRONMENT, "PATH": str(runtime / "bin") + ":" + build.ENVIRONMENT["PATH"],
                                      "GIT_CONFIG_SYSTEM": str(git_config), "FONTCONFIG_FILE": str(font_config),
                                      "FONTCONFIG_PATH": str(font_config.parent)})
        # A later current-pointer change must not redirect the recipe's tools.
        (self.root / "opt/zeros/current").unlink()
        (self.root / "opt/zeros/current").symlink_to("../zeros-infra/r1-" + "b" * 64)
        result = subprocess.run(["/usr/bin/bash", "-euo", "pipefail"], input='command -v git-lfs\ngit-lfs\ncat "$GIT_CONFIG_SYSTEM"\n',
                                text=True, env=environment, cwd=self.root, capture_output=True, check=True)
        self.assertEqual(result.stdout, str(runtime / "bin/git-lfs") + "\nfixture-lfs\n" + git_config.read_text())

    @unittest.skipUnless(shutil.which("fc-match"), "fontconfig command required for font discovery")
    def test_recipe_exec_discovers_a_synthetic_font_relative_to_its_runtime_config(self):
        root = "/opt/zeros-infra/" + RUNTIME + "/worker/design-fonts/"
        self.write(root + "fonts.conf", '<fontconfig><dir prefix="relative">.</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>', 0o444)
        font = self.write(root + "fixture/recipe.bdf", """STARTFONT 2.1
FONT -fixture-ZerosRecipe-Medium-R-Normal--16-160-75-75-C-80-ISO10646-1
SIZE 16 75 75
FONTBOUNDINGBOX 8 16 0 -2
STARTPROPERTIES 3
FAMILY_NAME "ZerosRecipe"
FONT_ASCENT 14
FONT_DESCENT 2
ENDPROPERTIES
CHARS 1
STARTCHAR A
ENCODING 65
SWIDTH 500 0
DWIDTH 8 0
BBX 8 16 0 -2
BITMAP
00
00
18
24
42
42
7E
42
42
42
00
00
00
00
00
00
ENDCHAR
ENDFONT
""", 0o444)
        environment = self.recipe_environment()
        result = subprocess.run(["/usr/bin/bash", "-euo", "pipefail"],
                                input='export XDG_CACHE_HOME="$PWD/cache"\nfc-match --format="%{file}" ZerosRecipe\n',
                                text=True, env=environment, cwd=self.root, capture_output=True, check=True)
        self.assertEqual(result.stdout, str(font))

    def test_recipe_environment_requires_a_selected_fully_verified_runtime(self):
        self.mkdir("/run/zeros")
        helper = self.root / "opt/zeros-bootstrap/bootstrap.py"
        original = helper.read_text()
        for replacement in ("None", repr("../untrusted")):
            with self.subTest(current=replacement):
                self.write("/opt/zeros-bootstrap/bootstrap.py", original.replace("return '" + RUNTIME + "'", "return " + replacement), 0o555)
                with self.assertRaises(build.Failure): self.app.install_environment()
        self.write("/opt/zeros-bootstrap/bootstrap.py", original.replace("return {}, b'fixture-receipt'", "raise source.Failure('file_digest')"), 0o555)
        with self.assertRaises(build.Failure): self.app.install_environment()

    def test_managed_clone_keeps_system_filters_disabled(self):
        with patch.object(build, "bounded_command", return_value=(0, b"fixture")) as command:
            self.assertEqual(self.app.git(["fixture"], self.root), b"fixture")
        environment = command.call_args.kwargs["environment"]
        self.assertEqual(environment["PATH"], build.ENVIRONMENT["PATH"])
        self.assertEqual(environment["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(environment["GIT_CONFIG_GLOBAL"], "/dev/null")
        self.assertEqual(environment["GIT_LFS_SKIP_SMUDGE"], "1")
        self.assertNotIn("GIT_CONFIG_SYSTEM", environment)

    def test_protected_file_and_compatibility_are_not_their_own_authority(self):
        digest = self.baseline()
        self.assertEqual(self.verify(digest)["protectedContractDigest"], digest)
        self.write("/opt/zeros-bootstrap/computer-build.py", "modified", 0o555)
        with self.assertRaises(build.Failure): self.verify(digest)
        self.write("/opt/zeros-bootstrap/compatibility.json", b'{}', 0o444)
        with self.assertRaises(build.Failure): self.baseline()

    def test_added_dropins_sudoers_apparmor_and_uid_change_fail(self):
        for path, value in (("/etc/systemd/system/zeros-host.service.d/override.conf", "override"),
                            ("/run/systemd/system/service.d/override.conf", "override"),
                            ("/etc/sudoers.d/addition", "new policy"),
                            ("/etc/apparmor.d/local/zeros-cloud-engine", "override")):
            with self.subTest(path=path):
                digest = self.baseline()
                target = self.write(path, value)
                with self.assertRaises(build.Failure): self.verify(digest)
                target.unlink()
        digest = self.baseline()
        self.write("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\nagent:x:10005:10001::/changed:/bin/bash\n")
        with self.assertRaises(build.Failure): self.verify(digest)

    def test_regular_package_install_is_allowed_and_protected_modes_links_are_not(self):
        digest = self.baseline()
        self.write("/usr/local/bin/custom-tool", "installed tool", 0o755)
        self.verify(digest)
        protected = self.root / "etc/systemd/system/zeros-host.service"
        protected.chmod(0o666)
        with self.assertRaises(build.Failure): self.verify(digest)
        protected.chmod(0o444)
        os.link(protected, self.root / "hardlink")
        with self.assertRaises(build.Failure): self.verify(digest)

    def test_writable_protected_ancestor_fails(self):
        digest = self.baseline()
        (self.root / "opt").chmod(0o777)
        with self.assertRaises(build.Failure): self.verify(digest)

    def test_optional_absence_and_ancestor_modes_are_in_external_digest(self):
        digest = self.baseline()
        # Both modes pass strict root ownership, but only the stock mode was
        # qualified. The absent service.d snapshot used to omit this change.
        (self.root / "usr/local").chmod(0o700)
        with self.assertRaises(build.Failure): self.verify(digest)

    def test_optional_absence_is_rechecked_when_computer_publishes_its_digest(self):
        original = self.app.protected_snapshot
        def late_change(*args):
            (self.root / "usr/local").chmod(0o700)
            return original(*args)
        with patch.object(self.app, "protected_snapshot", side_effect=late_change):
            with self.assertRaises(build.Failure): self.baseline()

    def test_actual_protected_file_never_uses_provider_ancestry_exception(self):
        target = "/usr/local/lib/systemd/system/zeros-example.service"
        self.write(target, "[Service]\n", 0o444)
        original = Path.lstat
        def provider_owned(path):
            info = original(path)
            if path != self.root / "usr/local": return info
            fields = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
            fields.update(st_uid=4242, st_gid=4242)
            return types.SimpleNamespace(**fields)
        with patch.object(Path, "lstat", autospec=True, side_effect=provider_owned):
            with self.assertRaises(build.Failure): self.app.snapshot(target)

    def test_qualified_provider_owned_optional_ancestors_allow_build_and_verify(self):
        original_stat, original_fstat, original_lstat = os.stat, os.fstat, os.lstat
        owned = {self.root / "usr/local", self.root / "usr/local/lib"}
        def metadata(info, path):
            if path not in owned: return info
            fields = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
            return types.SimpleNamespace(**{**fields, "st_uid": 4242, "st_gid": 4242})
        def file_stat(path, *args, **kwargs):
            absolute = Path(path)
            if kwargs.get("dir_fd") is not None:
                absolute = Path(os.readlink("/proc/self/fd/" + str(kwargs["dir_fd"]))) / absolute
            return metadata(original_stat(path, *args, **kwargs), absolute)
        def fd_stat(fd):
            return metadata(original_fstat(fd), Path(os.readlink("/proc/self/fd/" + str(fd))))
        def link_stat(path, *args, **kwargs):
            return metadata(original_lstat(path, *args, **kwargs), Path(path))
        with patch.object(os, "stat", side_effect=file_stat), patch.object(os, "fstat", side_effect=fd_stat), \
                patch.object(os, "lstat", side_effect=link_stat), patch.object(Path, "lstat", autospec=True, side_effect=link_stat):
            with self.assertRaises(build.Failure):
                self.app.protected_ancestors(self.root / "usr/local/lib/systemd/system/service.d")
            policy = self.optional_policy()
            stock_path = "/opt/zeros-bootstrap/stock-prerequisites.json"
            raw = build.packed({"optionalSystemd": policy})
            self.write(stock_path, raw, 0o444)
            contract = json.loads((self.root / "opt/zeros-bootstrap/compatibility.json").read_bytes())
            next(entry for entry in contract["protectedFiles"] if entry["path"] == stock_path)["sha256"] = build.sha(raw)
            raw = build.packed(contract)
            self.write("/opt/zeros-bootstrap/compatibility.json", raw, 0o444)
            self.tcb["baseCompatibilityId"] = "bc1-" + build.sha(raw)
            digest = self.baseline()
            self.assertEqual(self.verify(digest)["protectedContractDigest"], digest)
            self.write("/usr/local/lib/systemd/system/zeros-host.service", "override")
            with self.assertRaises(build.Failure): self.verify(digest)

    def test_subordinate_uid_and_gid_policy_is_protected(self):
        for path in ("/etc/subuid", "/etc/subgid"):
            with self.subTest(path=path):
                digest = self.baseline()
                self.write(path, "zeros-agent:200000:65536\n")
                with self.assertRaises(build.Failure): self.verify(digest)
                self.write(path, "zeros-agent:100000:65536\n")

    def test_approved_apparmor_mode_is_preserved_including_v4_unconfined_profile(self):
        path = "/sys/kernel/security/apparmor/profiles"
        self.write(path, "zeros-cloud-engine (unconfined)\n")
        digest = self.baseline()
        self.verify(digest)
        self.write(path, "zeros-cloud-engine (complain)\n")
        with self.assertRaises(build.Failure): self.verify(digest)
        self.write(path, "other-profile (enforce)\n")
        with self.assertRaises(build.Failure): self.baseline()

    def repository(self, *, lfs=False, unsafe_link=False):
        source = self.root / "origin"
        source.mkdir()
        def git(*args):
            return subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", *args], cwd=source,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout.decode().strip()
        git("init", "-q")
        (source / "file").write_text("version https://git-lfs.github.com/spec/v1\noid sha256:" + "a" * 64 + "\nsize 1\n" if lfs else "repository data")
        if unsafe_link: (source / "escape").symlink_to("/root/.ssh")
        git("add", ".")
        git("commit", "-qm", "fixture")
        commit = git("rev-parse", "HEAD")
        calls = []
        original = self.app.git
        def local_git(args, cwd, environment=None, timeout=60):
            calls.append((args, environment or {}))
            self.assertFalse(any("synthetic-clone-credential" in item for item in args))
            self.assertNotIn("synthetic-clone-credential", json.dumps(environment))
            args = [str(source) if item == "https://github.com/fixture/repo.git" and "fetch" in args else item for item in args]
            return original(["-c", "protocol.file.allow=always", *args], cwd, environment, timeout)
        self.app.git = local_git
        document = {"schema": "zeros.computer-repositories-input/v1", **JOB, "repositories": [{"id": "123", "owner": "fixture", "name": "repo", "ref": commit,
            "credential": {"token": "synthetic-clone-credential", "expiresAt": "2099-01-01T00:00:00Z"}}]}
        return document, commit, calls

    def test_shallow_repo_manifest_clean_remote_no_helpers_or_token_on_disk(self):
        document, commit, calls = self.repository()
        result = self.app.clone_repos(document)
        self.assertEqual(result["repositories"], [{"id": "123", "owner": "fixture", "name": "repo", "sha": commit}])
        repo = self.root / "srv/zeros/files/repos/fixture/repo"
        config = (repo / ".git/config").read_text()
        self.assertIn("https://github.com/fixture/repo.git", config)
        self.assertNotIn("credential", config)
        self.assertTrue((repo / ".git/shallow").exists())
        self.assertEqual((repo / "file").stat().st_uid, os.getuid())
        for path in self.root.rglob("*"):
            if path.is_file() and not path.is_symlink(): self.assertNotIn(b"synthetic-clone-credential", path.read_bytes())

    def test_sanitize_overwrites_visible_repository_hooks_without_unlink(self):
        document, _, _ = self.repository()
        repositories = self.app.clone_repos(document)['repositories']
        hook = self.write('/srv/zeros/files/repos/fixture/repo/.git/hooks/post-checkout',
                          '#!/bin/sh\nprintf inherited > inherited-hook-ran\n', 0o755)
        inode, inherited = hook.stat().st_ino, hook.read_bytes()
        request = self.sanitation_request()
        request['manifest']['repositoryManifest'] = repositories
        request['manifestSha256'] = build.sha(build.packed(request['manifest']))
        self.app.sanitize(request)
        saved = hook.read_bytes() if hook.exists() else inherited
        self.assertEqual(saved, b'', 'incremental capture retained an executable hook')
        self.assertEqual(hook.stat().st_ino, inode)

    def test_restored_git_does_not_execute_an_inherited_hook_absent_at_sanitation(self):
        document, commit, _ = self.repository()
        repositories = self.app.clone_repos(document)['repositories']
        repo = self.root / 'srv/zeros/files/repos/fixture/repo'
        hook = self.write('/srv/zeros/files/repos/fixture/repo/.git/hooks/post-checkout',
                          '#!/bin/sh\nprintf inherited > inherited-hook-ran\n', 0o755)
        inherited = hook.read_bytes()
        hook.unlink()  # Removed before the live sanitizer can discover it.
        request = self.sanitation_request()
        request['manifest']['repositoryManifest'] = repositories
        request['manifestSha256'] = build.sha(build.packed(request['manifest']))
        self.app.sanitize(request)
        hook.parent.mkdir(exist_ok=True)
        hook.write_bytes(inherited)  # The provider restores the ancestor entry.
        hook.chmod(0o755)
        result = subprocess.run(['git', 'checkout', '--quiet', '--detach', commit], cwd=repo,
                                env={**build.ENVIRONMENT, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'},
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0, 'ordinary restored Git checkout failed')
        self.assertFalse((repo / 'inherited-hook-ran').exists(), 'ordinary Git executed an inherited hook')
        self.assertEqual((repo / 'file').read_text(), 'repository data')
        # A workspace can deliberately install fresh hooks after replacing
        # the template setting. No global or Local-workspace policy is changed.
        hook.write_bytes(b'#!/bin/sh\nprintf approved > intentional-hook-ran\n')
        environment = {**build.ENVIRONMENT, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        for arguments in (['config', '--local', 'core.hooksPath', '.git/hooks'], ['checkout', '--quiet', '--detach', commit]):
            result = subprocess.run(['git', *arguments], cwd=repo, env=environment,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            self.assertEqual(result.returncode, 0, 'explicit workspace hook installation failed')
        self.assertEqual((repo / 'intentional-hook-ran').read_text(), 'approved')

    def test_hook_alias_fails_sanitation_without_truncating_repository_content(self):
        document, _, _ = self.repository()
        repositories = self.app.clone_repos(document)['repositories']
        repo = self.root / 'srv/zeros/files/repos/fixture/repo'
        hooks = repo / '.git/hooks'
        hooks.mkdir(exist_ok=True)
        (hooks / 'post-checkout').symlink_to('../../file')
        request = self.sanitation_request()
        request['manifest']['repositoryManifest'] = repositories
        request['manifestSha256'] = build.sha(build.packed(request['manifest']))
        with self.assertRaises(build.Failure):
            self.app.sanitize(request)
        self.assertEqual((repo / 'file').read_text(), 'repository data')


    def test_empty_repository_list_does_not_create_repo_projection(self):
        result = self.app.clone_repos({"schema": "zeros.computer-repositories-input/v1", **JOB, "repositories": []})
        self.assertEqual(result["repositories"], [])
        self.assertFalse((self.root / "srv/zeros/files/repos").exists())

    def test_repository_access_with_umask_077_before_and_after_sanitize(self):
        # The ordinary suite checks exact parent modes. Running this suite as
        # root also exercises real access from the distinct workspace UID/GID.
        if os.geteuid() == 0:
            self.app.repo_uid = self.app.repo_gid = 10001
            self.assertNotEqual(self.app.uid, self.app.repo_uid)
        for path in ("/srv", "/srv/zeros", "/srv/zeros/files"):
            self.mkdir(path).chmod(0o755)
        document, _, _ = self.repository()
        original_umask = os.umask(0o077)
        try:
            repositories = self.app.clone_repos(document)["repositories"]
            private = self.root / "run/zeros/computer-build" / JOB["buildId"]
            self.assertEqual(private.stat().st_mode & 0o7777, 0o700)
            self.assertEqual(private.stat().st_uid, self.app.uid)

            def accessible():
                for path in ("srv/zeros/files/repos", "srv/zeros/files/repos/fixture"):
                    metadata = (self.root / path).stat()
                    self.assertEqual(metadata.st_mode & 0o7777, 0o755)
                    self.assertEqual((metadata.st_uid, metadata.st_gid), (self.app.uid, self.app.gid))
                repo = self.root / "srv/zeros/files/repos/fixture/repo"
                self.assertEqual(repo.stat().st_uid, self.app.repo_uid)
                identity = {"user": self.app.repo_uid, "group": self.app.repo_gid, "extra_groups": []} if os.geteuid() == 0 else {}
                result = subprocess.run([sys.executable, "-I", "-c",
                    "from pathlib import Path; import sys; p=Path(sys.argv[1]); "
                    "assert (p/'file').read_text() == 'repository data'; "
                    "q=p/'workspace-write'; q.write_text('writable'); q.unlink()", str(repo)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, **identity)
                self.assertEqual(result.returncode, 0, "workspace identity cannot access its checkout")

            accessible()
            manifest = {"schema": "zeros.computer-template/v1", "buildId": JOB["buildId"], "configId": JOB["buildId"], "baseImageId": "fixture-base",
                        "runtimeId": RUNTIME, "baseCompatibilityId": self.compatibility, "repositoryManifest": repositories, "protectedContractDigest": self.baseline()}
            # Sanitation must establish the contract even if a root recipe
            # tightened the repository parents after cloning.
            for path in ("srv/zeros/files/repos", "srv/zeros/files/repos/fixture"):
                (self.root / path).chmod(0o700)
            self.app.host = FakeHost()
            self.app.sanitize({"schema": "zeros.computer-sanitation-input/v1", **JOB, "manifest": manifest, "manifestSha256": build.sha(build.packed(manifest))})
            accessible()
            self.assertTrue(private.is_dir())
            self.assertTrue(all(path.is_dir() or path.is_file() and path.stat().st_size == 0 for path in private.rglob("*")))
        finally:
            os.umask(original_umask)

    def test_lfs_and_escaping_repository_symlinks_fail_closed(self):
        document, _, _ = self.repository(lfs=True)
        with self.assertRaises(build.Failure): self.app.clone_repos(document)

    def test_repository_link_escape_is_rejected_before_ownership_traversal(self):
        document, _, _ = self.repository(unsafe_link=True)
        with self.assertRaises(build.Failure): self.app.clone_repos(document)

    def test_start_is_idempotent_and_fenced_even_after_lost_reply(self):
        class LocalHost:
            def install_command(self, _identity, _timeout): return ["/usr/bin/bash", "-euo", "pipefail"]
            def drain_install(self, _identity): pass
        self.app.host = LocalHost()
        self.app.clone_repos({"schema": "zeros.computer-repositories-input/v1", **JOB, "repositories": []})
        marker = self.root / "count"
        document = {"schema": "zeros.computer-install-input/v1", **JOB, "action": "start", "after": 0,
                    "script": "printf x >> " + str(marker), "timeoutSeconds": 2, "redactions": []}
        self.app.run_install(document)
        self.app.run_install(document)
        limit = time.monotonic() + 5
        while self.app.run_install({"schema": document["schema"], **JOB, "action": "poll", "after": 0})["state"] == "running":
            self.assertLess(time.monotonic(), limit)
            time.sleep(0.02)
        self.app.run_install(document)
        self.assertEqual(marker.read_text(), "x")
        with self.assertRaises(build.Failure): self.app.run_install({**document, "workerFence": 8})
        with self.assertRaises(build.Failure): self.app.run_install({**document, "script": "false"})
        try: os.waitpid(-1, 0)
        except ChildProcessError: pass

    def sanitation_request(self):
        manifest = {"schema": "zeros.computer-template/v1", "buildId": JOB["buildId"], "configId": JOB["buildId"], "baseImageId": "fixture-base",
                    "runtimeId": RUNTIME, "baseCompatibilityId": self.compatibility, "repositoryManifest": [], "protectedContractDigest": self.baseline()}
        self.app.host = FakeHost()
        return {"schema": "zeros.computer-sanitation-input/v1", **JOB, "manifest": manifest, "manifestSha256": build.sha(build.packed(manifest))}

    def test_sanitize_overwrites_inherited_private_entries_without_deleting_paths(self):
        private = ("/root/.ssh/id", "/root/.cache/nested/private", "/root/.local/state/private", "/home/user/.env.fixture",
                   "/home/user/.codex/auth.json", "/srv/zeros/setup/admission", "/srv/zeros/state/workspaces/session",
                   "/srv/zeros/home/agent/.claude/session", "/srv/zeros/home/capture/session", "/srv/zeros/log/private",
                   "/srv/zeros/files/state/private", "/srv/zeros/managed-settings/extra/private",
                   "/srv/zeros/managed-settings/settings.managed.toml", "/opt/zeros/sessions/boot.json",
                   "/opt/zeros/sessions/reconciliation.json", "/var/log/journal/private", "/run/log/journal/private",
                   "/run/zeros/active-runtime.json", "/run/zeros/computer-build/" + JOB["buildId"] + "/install.json",
                   "/var/lib/systemd/random-seed", "/var/lib/systemd/timesync/clock", "/opt/zeros/disk-epoch")
        for path in private:
            self.write(path, "4\n" if path.endswith("disk-epoch") else "synthetic private state", 0o600)
        request = self.sanitation_request()
        before = {path: (self.app.path(path).read_bytes(), self.app.path(path).stat().st_ino) for path in private}
        parents = {self.app.path(path).parent: self.app.path(path).parent.stat().st_ino for path in private}
        result = self.app.sanitize(request)
        # An incremental capture can retain an ancestor entry when the live
        # path was deleted. Only an explicit empty replacement clears its bytes.
        saved = {path: value[0] for path, value in before.items()}
        saved.update({path: self.app.path(path).read_bytes() for path in private if self.app.path(path).exists()})
        self.assertTrue(result["clean"])
        self.assertEqual([path for path, data in saved.items() if data], [], "incremental capture retained private bytes")
        for path, (_, inode) in before.items():
            self.assertEqual(self.app.path(path).stat().st_ino, inode)
        for path, inode in parents.items():
            self.assertEqual(path.stat().st_ino, inode)
        self.verify(request["manifest"]["protectedContractDigest"])

    def test_sanitize_materializes_known_markers_missing_from_live_tree(self):
        self.mkdir("/opt/zeros/sessions").chmod(0o700)
        markers = ("/opt/zeros/disk-epoch", "/opt/zeros/sessions/boot.json", "/opt/zeros/sessions/reconciliation.json",
                   "/run/zeros/active-runtime.json", "/var/lib/systemd/random-seed", "/var/lib/systemd/timesync/clock")
        for path in markers:
            self.write(path, "ancestor snapshot bytes", 0o600).unlink()
        self.app.sanitize(self.sanitation_request())
        for path in markers:
            with self.subTest(path=path):
                target = self.app.path(path)
                self.assertTrue(target.exists() and stat.S_ISREG(target.lstat().st_mode), "known inherited marker was not superseded")
                self.assertEqual(target.read_bytes(), b"")
                self.assertEqual(target.stat().st_nlink, 1)
        self.assertTrue(self.app.path("/run/zeros/computer-build").is_dir())

    def test_sanitize_refuses_private_aliases_and_special_files(self):
        victim = self.write("/outside/private", "unrelated bytes")
        for kind in ("symlink", "directory-alias", "hardlink", "fifo"):
            with self.subTest(kind=kind):
                target = self.app.path("/root/.netrc")
                target.parent.mkdir(parents=True, exist_ok=True)
                if kind == "symlink": target.symlink_to(victim)
                elif kind == "directory-alias": target.symlink_to(victim.parent, target_is_directory=True)
                elif kind == "hardlink": os.link(victim, target)
                else: os.mkfifo(target)
                try:
                    with self.assertRaises(build.Failure):
                        self.app.sanitize(self.sanitation_request())
                    self.assertEqual(victim.read_text(), "unrelated bytes")
                finally:
                    target.unlink(missing_ok=True)

    def test_default_computer_sanitation_keeps_cache_socket_refusal(self):
        target = self.app.path('/home/user/.cache/stock.sock')
        target.parent.mkdir(parents=True, exist_ok=True)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(target))
            with self.assertRaises(build.Failure) as caught: self.app.sanitize(self.sanitation_request())
            self.assertEqual(caught.exception.check, 'sanitation_failed')
            self.assertTrue(stat.S_ISSOCK(target.lstat().st_mode))

    def test_sanitize_checks_opened_file_before_truncating_a_raced_hardlink(self):
        victim = self.write("/outside/private", "unrelated bytes")
        target = self.write("/root/.netrc", "synthetic private state", 0o600)
        request = self.sanitation_request()
        real_open = os.open
        raced = False

        def opened(path, flags, *args, **kwargs):
            nonlocal raced
            if str(path).endswith(".netrc") and flags & (os.O_WRONLY | os.O_RDWR):
                self.assertFalse(flags & os.O_TRUNC, "metadata must be checked before truncation")
                if not raced:
                    raced = True
                    target.unlink()
                    os.link(victim, target)
            return real_open(path, flags, *args, **kwargs)

        with patch.object(build.os, "open", side_effect=opened):
            with self.assertRaises(build.Failure):
                self.app.sanitize(request)
        self.assertTrue(raced)
        self.assertEqual(victim.read_text(), "unrelated bytes")

    def test_sanitize_rejects_invalid_marker_metadata_before_clearing_its_bytes(self):
        target = self.write("/opt/zeros/sessions/boot.json", "synthetic boot intent", 0o644)
        with self.assertRaises(build.Failure): self.app.sanitize(self.sanitation_request())
        self.assertEqual(target.read_bytes(), b"synthetic boot intent")

    def test_journal_preparation_keeps_archived_files_visible_for_overwrite(self):
        target = self.write("/var/log/journal/fixture/archived.journal", "synthetic journal bytes", 0o600)
        request = self.sanitation_request()
        self.app.host = build.SystemHost()
        commands = []

        def command(arguments, **_kwargs):
            commands.append(arguments)
            if any(arg.startswith("--vacuum") for arg in arguments): target.unlink()
            return 0, b""

        with patch.object(build, "bounded_command", side_effect=command):
            self.app.sanitize(request)
        self.assertTrue(target.is_file(), "vacuum hid an inherited journal entry before zeroization")
        self.assertEqual(target.read_bytes(), b"")
        self.assertIn(["/usr/bin/journalctl", "--sync"], commands)

    def test_sanitize_refuses_a_detached_parent_before_truncating(self):
        target = self.write("/root/.ssh/id", "synthetic private state", 0o600)
        outside = self.write("/outside/id", "unrelated bytes")
        request = self.sanitation_request()
        real_open = os.open
        detached = target.parent.with_name("detached-fixture")
        raced = False

        def opened(path, flags, *args, **kwargs):
            nonlocal raced
            if str(path) == "id" and flags & (os.O_WRONLY | os.O_RDWR) and not raced:
                raced = True
                target.parent.rename(detached)
                target.parent.symlink_to(outside.parent, target_is_directory=True)
            return real_open(path, flags, *args, **kwargs)

        with patch.object(build.os, "open", side_effect=opened):
            with self.assertRaises(build.Failure): self.app.sanitize(request)
        self.assertTrue(raced)
        self.assertEqual(outside.read_bytes(), b"unrelated bytes")
        self.assertEqual((detached / "id").read_bytes(), b"synthetic private state")

    def test_sanitize_preserves_repositories_runtime_and_manifest_but_empties_private_state(self):
        document, commit, _ = self.repository()
        repositories = self.app.clone_repos(document)["repositories"]
        # §23's physical root must survive; sanitation owns explicit private
        # targets through logical binds, never a recursive /home/user wipe.
        persistent = self.write("/home/user/.zeros-persist/files/retained", "retained data")
        for path in ("/root/.ssh/id", "/root/.bash_history", "/home/user/.git-credentials", "/srv/zeros/setup/admission", "/srv/zeros/state/workspaces/session",
                     "/srv/zeros/log/script", "/srv/zeros/home/agent/.bash_history", "/srv/zeros/home/capture/session",
                     "/srv/zeros/files/state/private", "/srv/zeros/managed-settings/settings.managed.toml",
                     "/opt/zeros/sessions/session", "/var/log/journal/private", "/opt/zeros/disk-epoch"):
            self.write(path, "private state")
        skeleton = {"/srv/zeros/home/agent": 0o755, "/srv/zeros/home/capture": 0o700,
                    "/srv/zeros/state": 0o700, "/srv/zeros/state/workspaces": 0o700,
                    "/srv/zeros/log": 0o750, "/srv/zeros/managed-settings": 0o750}
        for path, mode in skeleton.items(): self.mkdir(path).chmod(mode)
        managed = self.root / "srv/zeros/managed-settings/settings.managed.toml"
        managed.chmod(0o640)
        self.write("/etc/machine-id", "machine identity")
        self.write("/opt/zeros/disk-epoch", "123\n", 0o600)
        manifest = {"schema": "zeros.computer-template/v1", "buildId": JOB["buildId"], "configId": JOB["buildId"], "baseImageId": "fixture-base",
                    "runtimeId": RUNTIME, "baseCompatibilityId": self.compatibility, "repositoryManifest": repositories, "protectedContractDigest": self.baseline()}
        self.app.host = FakeHost()
        result = self.app.sanitize({"schema": "zeros.computer-sanitation-input/v1", **JOB, "manifest": manifest, "manifestSha256": build.sha(build.packed(manifest))})
        self.assertTrue(result["clean"])
        self.assertEqual(persistent.read_text(), "retained data")
        self.assertEqual((self.root / "srv/zeros/files/repos/fixture/repo/file").read_text(), "repository data")
        self.assertEqual((self.root / "opt/zeros-infra" / RUNTIME / "fixture").read_text(), "verified runtime")
        self.assertEqual((self.root / "etc/machine-id").read_bytes(), b"")
        for path in ("root/.ssh/id", "srv/zeros/setup/admission", "opt/zeros/sessions/session", "srv/zeros/files/state/private"):
            self.assertEqual((self.root / path).read_bytes(), b"")
        for path, mode in skeleton.items():
            target = self.root / path.lstrip("/")
            self.assertTrue(target.is_dir())
            self.assertEqual(target.stat().st_mode & 0o7777, mode)
            self.assertEqual(target.stat().st_uid, os.getuid())
        self.assertEqual(managed.read_bytes(), b"")
        self.assertEqual(managed.stat().st_mode & 0o7777, 0o640)
        for path in ("srv/zeros/state/workspaces/session", "srv/zeros/home/agent/.bash_history", "srv/zeros/home/capture/session"):
            self.assertEqual((self.root / path).read_bytes(), b"")
        self.assertEqual(json.loads((self.root / "srv/zeros/computer-template.json").read_bytes()), manifest)
        # The digest must remain meaningful on the archived template. Epoch
        # contents and private session payloads are explicit metadata exclusions.
        self.verify(manifest["protectedContractDigest"])


class FakeHost:
    def stop_host(self): pass
    def sync_journal(self): pass


class Install(unittest.TestCase):
    def test_poll_bounds_escaped_batches_including_the_final_diagnostic(self):
        with tempfile.TemporaryDirectory() as root:
            store = build.InstallStore(Path(root), JOB)
            store.initialize("test")
            text = ('\\"\t\n' * 8192) + ('🙂' * 8192)
            store.append("stdout", text)
            store.finish(0, False)
            diagnostic = build.packed({"schema": "zeros.diagnostic/v1", "component": "build", "stage": "install",
                                      "ok": True, "exitCode": 0, "timedOut": False, "failedChecks": []})
            after, result = 0, []
            for _ in range(32):
                status = store.status(after)
                self.assertLessEqual(len(build.packed(status)) + len(diagnostic) + 2, 65536)
                result.extend(row["text"] for row in status["chunks"])
                if status["state"] == "succeeded": break
                self.assertGreater(status["nextAfter"], after)
                self.assertIsNone(status["exitCode"])
                after = status["nextAfter"]
            else: self.fail("bounded log polling did not complete")
            self.assertEqual("".join(result), text)

    def test_install_script_enters_a_private_logical_repository_namespace(self):
        args = build.SystemHost().install_command(JOB["buildId"], 900)
        self.assertIn("--property=WorkingDirectory=/", args)
        self.assertEqual(args[-10:], ["/usr/bin/unshare", "--mount", "--propagation", "private", "--",
                                     "/usr/bin/python3", "-I", "-B", "/opt/zeros-bootstrap/computer-build.py", "install-shell"])

    def test_unknown_cgroup_status_is_not_evidence_of_drain(self):
        with patch.object(build, "bounded_command", return_value=(1, b"")):
            with self.assertRaises(build.Failure): build.SystemHost().drain_install(JOB["buildId"])

    def test_collected_unit_is_drained_only_with_positive_not_found_evidence(self):
        with patch.object(build, "bounded_command", side_effect=[(0, b""), (1, b""), (1, b"not-found\n")]):
            build.SystemHost().drain_install(JOB["buildId"])

    def test_root_service_has_strict_bash_deadline_and_bounded_cgroup(self):
        args = build.SystemHost().install_command(JOB["buildId"], 900)
        for option in ("--property=User=0", "--property=Group=0", "--property=KillMode=control-group", "--property=RuntimeMaxSec=900s", "--property=TasksMax=512",
                       "--property=ReadOnlyPaths=/opt/zeros-bootstrap", "--property=ProtectControlGroups=yes"):
            self.assertIn(option, args)
        self.assertIn("/usr/bin/unshare", args)

    def test_script_failure_timeout_and_split_logs(self):
        with tempfile.TemporaryDirectory() as root:
            store = build.InstallStore(Path(root), JOB)
            store.initialize("test")
            build.run_process(["/usr/bin/bash", "-euo", "pipefail"], "printf 'synthetic-'; printf 'credential\\n'; exit 7", 2, store,
                              build.LogFilter(["synthetic-credential"]), cwd=root)
            status = store.status(0)
            self.assertEqual(status["state"], "failed")
            self.assertEqual(status["exitCode"], 7)
            self.assertEqual("".join(row["text"] for row in status["chunks"]), "[redacted]\n")
        with tempfile.TemporaryDirectory() as root:
            store = build.InstallStore(Path(root), JOB)
            store.initialize("test")
            build.run_process(["/usr/bin/bash", "-euo", "pipefail"], "sleep 30 & wait", 0.1, store, build.LogFilter([]), cwd=root)
            self.assertTrue(store.status(0)["timedOut"])


if __name__ == "__main__":
    unittest.main()
