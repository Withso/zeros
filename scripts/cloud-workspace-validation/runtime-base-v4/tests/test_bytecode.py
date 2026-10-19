"""Captured guest entry points must not write stdlib caches into stock /usr."""
import ast
import importlib.util
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[4]
BASE = ROOT / "scripts/cloud-workspace-validation/runtime-base-v4"
TEMPLATES = ROOT / "scripts/cloud-workspace-validation/boat-image/templates"


def startup_options(arguments):
    start = next(index for index, value in enumerate(arguments) if value.endswith("python3")) + 1
    flags = []
    for value in arguments[start:]:
        if value in ("-", "-c", "-m") or not value.startswith("-"): break
        flags.append(value)
    return flags


def imports_only(source):
    # Execute the real ordered imports and bytecode guard, never a guest's
    # privileged actions. A fresh -X prefix makes existing caches irrelevant.
    body = [node for node in ast.parse(source).body if isinstance(node, (ast.Import, ast.ImportFrom)) or
            isinstance(node, ast.Assign) and any(isinstance(target, ast.Attribute) and
            isinstance(target.value, ast.Name) and target.value.id == "sys" and target.attr == "dont_write_bytecode"
            for target in node.targets)]
    return ast.unparse(ast.Module(body=body, type_ignores=[]))


def launches():
    cases = []
    build = (TEMPLATES / "v4/build.sh").read_text()
    for index, match in enumerate(re.finditer(r"^(python3 [^\n]+) <<'PY'\n(.*?)\nPY", build, re.M | re.S)):
        cases.append(("build-inline-" + str(index), startup_options(shlex.split(match[1])), match[2]))
    stock = next(line for line in build.splitlines() if line.startswith("python3 ") and "stock-prerequisites.py" in line)
    cases.append(("stock-preflight", startup_options(shlex.split(stock)), (BASE / "stock-prerequisites.py").read_text()))
    for name in ("boot.sh", "dispatch.sh", "install-runtime.sh"):
        command = next(line for line in (BASE / name).read_text().splitlines() if line.startswith("exec "))
        cases.append((name, startup_options(shlex.split(command)), (BASE / "bootstrap.py").read_text()))
    for name in ("bootstrap.py", "computer-build.py", "computer-git-askpass.py", "stock-prerequisites.py"):
        source = (BASE / name).read_text()
        cases.append((name + "-shebang", startup_options(shlex.split(source.splitlines()[0][2:])), source))
    spec = importlib.util.spec_from_file_location("bytecode_computer", BASE / "computer-build.py")
    computer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(computer)
    cases.append(("recipe-systemd", startup_options(computer.SystemHost().install_command("fixture", 10)), (BASE / "computer-build.py").read_text()))
    kit = (TEMPLATES.parent / "runtime-base-v4.ts").read_text()
    probe = re.search(r"return `([^`\n]+)<<'PYV4'", kit)[1]
    flags = startup_options(shlex.split(probe))
    for name, path in (("verify", TEMPLATES / "v4/verify.py"), ("sanitize", TEMPLATES / "v4/sanitize.py"),
                       ("runtime-probe", BASE / "runtime_probe.py"), ("persistence-probe", BASE / "persistence_probe.py")):
        cases.append((name + "-remote", flags, path.read_text()))
    line = next(line.strip() for line in kit.splitlines() if "subprocess.Popen([" in line)
    arguments = ast.parse(line).body[0].value.args[0].elts
    flags = startup_options([node.value for node in arguments if isinstance(node, ast.Constant)])
    cases.append(("uploaded-runner", flags, (TEMPLATES / "owned-runner.py").read_text()))
    for relative in ("apps/control-plane/src/cloud-workspaces/cloud-builder-commands.ts",
                     "apps/control-plane/src/cloud-workspaces/boat-setup-runner.ts",
                     "scripts/cloud-workspace-validation/template-setup-repro.mjs",
                     "scripts/cloud-workspace-validation/workspace-perf-vm.mjs",
                     "scripts/cloud-workspace-validation/engine-connect-repro.mjs"):
        commands = re.findall(r'/usr/bin/python3 [^"`\n]+', (ROOT / relative).read_text())
        assert commands, relative
        for index, command in enumerate(commands):
            entry = BASE / ("computer-build.py" if "computer-build.py" in command else "bootstrap.py")
            if "PY_PERF" in command: entry = BASE.parent / "workspace-perf-bootstrap.py"
            cases.append((relative + ":" + str(index), startup_options(shlex.split(command)), entry.read_text()))
    source = (ROOT / "scripts/cloud-workspace-validation/sandbox/runtime-self-test.mjs").read_text()
    for index, arguments in enumerate(re.findall(r'command\("/usr/bin/python3", (\[[^\]]+\])', source)):
        arguments = json.loads(arguments)
        program = arguments[arguments.index("-c") + 1] if "-c" in arguments else (BASE / "bootstrap.py").read_text()
        cases.append(("runtime-self-test:" + str(index), startup_options(["python3", *arguments]), program))
    source = (ROOT / "scripts/cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs").read_text()
    flags = json.loads("[" + re.search(r'spawnSync\("/usr/bin/python3", \[(.*?), VERIFY_SELECTED_RUNTIME', source)[1] + "]")
    program = re.search(r"const VERIFY_SELECTED_RUNTIME = `(.*?)`;", source, re.S)[1]
    cases.append(("supervisor-selected-runtime", startup_options(["python3", *flags]), program))
    update = ROOT / "apps/control-plane/src/cloud-workspaces"
    source = (update / "runtime-update-runner.ts").read_text()
    command = re.search(r"command: `(/usr/bin/python3 .*?) -c ", source)[1]
    adapter = (update / "runtime-update-adapter.py").read_text()
    cases.append(("runtime-update-loader", startup_options(shlex.split(command)), adapter))
    cases.append(("runtime-update-shebang", startup_options(shlex.split(adapter.splitlines()[0][2:])), adapter))
    source = (update / "boat-pinned-ssh.ts").read_text()
    launch = re.search(r"return `(/usr/bin/python3 .*?)<<'PY'\n(.*?)home=os.open", source, re.S)
    cases.append(("pinned-ssh-key", startup_options(shlex.split(launch[1])), launch[2]))
    source = (ROOT / "scripts/cloud-workspace-validation/sandbox/cloud-setup-process.mjs").read_text()
    launch = re.search(r"const command = `(python3 .*?)<<'ZEROS_SETUP_CANARY'\\n(.*?)\\nsubprocess.Popen", source)
    cases.append(("setup-canary", startup_options(shlex.split(launch[1])), launch[2]))
    child = re.search(r"subprocess.Popen\(\['/usr/bin/setsid','/usr/bin/python3',(.*?)\$\{JSON.stringify\(workerSource\)", source)[1]
    program = re.search(r"const workerSource = `(.*?)\\npathlib", source)[1]
    cases.append(("setup-canary-child", startup_options(["python3", *re.findall(r"'([^']+)'", child)]), program))
    launch = re.search(r'command: "exec (python3 .*?) \'(.*?)\'"', source)
    cases.append(("setup-timeout", startup_options(shlex.split(launch[1])), launch[2]))
    # Includes both the initial and final fresh supervisor status in the full
    # Computer self-test; each discovered invocation still gets the cache proof.
    assert len(cases) == 37, f"update the guest entry-point inventory when a launcher changes (found {len(cases)})"
    return cases


class Bytecode(unittest.TestCase):
    def test_actual_guest_launch_arguments_disable_isolated_bytecode(self):
        for entry, flags, _source in launches():
            with self.subTest(entry=entry):
                if entry != "pinned-ssh-key" and not entry.startswith("setup-"):
                    self.assertTrue(any(re.fullmatch(r"-[IB]*I[IB]*", value) for value in flags), flags)
                self.assertTrue(any(re.fullmatch(r"-[IB]*B[IB]*", value) for value in flags), flags)

    def test_every_guest_entry_keeps_an_empty_cache_prefix_empty(self):
        for entry, flags, source in launches():
            with self.subTest(entry=entry), tempfile.TemporaryDirectory() as directory:
                cache = Path(directory) / "cache"
                result = subprocess.run([sys.executable, *flags, "-X", "pycache_prefix=" + str(cache), "-"],
                                        input=imports_only(source), text=True, capture_output=True, timeout=15,
                                        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(list(cache.rglob("*.pyc")), [], entry)

    def test_empty_cache_prefix_control_detects_writes_even_with_environment_opt_out(self):
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run([sys.executable, "-I", "-X", "pycache_prefix=" + directory, "-c", "import hashlib"],
                           env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}, check=True, timeout=15)
            self.assertTrue(list(Path(directory).rglob("*.pyc")))


if __name__ == "__main__":
    unittest.main()
