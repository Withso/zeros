import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

const nativeNamespaces =
  process.platform === "linux" &&
  spawnSync(
    "sudo",
    [
      "-n",
      "/usr/bin/bwrap",
      "--ro-bind",
      "/",
      "/",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--",
      "/usr/bin/true",
    ],
    { stdio: "ignore" },
  ).status === 0;
const sandbox = path.resolve("scripts/cloud-workspace-validation/sandbox");
const helper = path.resolve(
  "scripts/cloud-workspace-validation/runtime-base-v4/computer-build.py",
);

describe("computer template repository projection", () => {
  it.skipIf(process.platform !== "linux" || !process.env.CI)(
    "requires native namespace coverage on Linux CI",
    () => {
      expect(nativeNamespaces, "Run through scripts/ci/with-userns.sh with sudo and bubblewrap installed").toBe(true);
    },
  );
  it.skipIf(!nativeNamespaces).each([
    {
      name: "empty repository selection",
      repositoryCount: 0,
      alteration: "",
      error: null,
    },
    {
      name: "two cloned repositories",
      repositoryCount: 2,
      alteration: "",
      error: null,
    },
    {
      name: "writable owner directory",
      repositoryCount: 2,
      alteration: "fs.chmodSync('/srv/zeros/files/repos/fixture',0o777)",
      error: "Unsafe cloud launch source",
    },
    {
      name: "wrong checkout owner",
      repositoryCount: 2,
      alteration: "fs.chownSync('/srv/zeros/files/repos/fixture/repo0',0,0)",
      error: "Unsafe cloud computer repository projection",
    },
    {
      name: "unadopted legacy checkout owner",
      repositoryCount: 2,
      alteration: "fs.chownSync('/srv/zeros/files/repos/fixture/repo0',10001,10001)",
      error: "Unsafe cloud computer repository projection",
    },
    {
      name: "symlinked repository root",
      repositoryCount: 2,
      alteration:
        "fs.rmSync('/srv/zeros/files/repos',{recursive:true}); fs.symlinkSync('/srv/zeros/files/workspace','/srv/zeros/files/repos')",
      error: "Noncanonical cloud launch source",
    },
    {
      name: "unexpected private sibling",
      repositoryCount: 2,
      alteration: "fs.mkdirSync('/srv/zeros/files/broker')",
      error: "Unexpected cloud engine file projection",
    },
  ])(
    "checks $name through the real v4 engine view",
    ({ repositoryCount, alteration, error }) => {
      const tree = cloudRuntimeFixture({ mapAbsoluteLinks: false });
      const runtime = createCloudRuntimeResolver({
        filesystem: tree.filesystem,
      }).resolve();
      try {
        tree.write(`${runtime.workerRoot}/package.json`, {});
        for (const name of [
          "cloud-engine-launcher.mjs",
          "cloud-engine-view.mjs",
          "cloud-computer-checkout.mjs",
          "cloud-engine-cgroup.mjs",
          "cgroup-resources.mjs",
          "cloud-resource-admission.mjs",
          "publish-cloud-workload-custody.mjs",
          "cloud-runtime-profile.mjs",
          "cloud-runtime-root.mjs",
          "runtime-layout.json",
          "prepare-cloud-image-files.mjs",
        ])
          tree.write(
            `${runtime.libRoot}/${name}`,
            readFileSync(path.join(sandbox, name), "utf8"),
          );
        unlinkSync(tree.physical(runtime.node));
        copyFileSync(process.execPath, tree.physical(runtime.node));
        chmodSync(tree.physical(runtime.node), 0o555);
        unlinkSync(tree.physical(runtime.engineNamespace));
        execFileSync(
          "cc",
          [
            "-std=c11",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            path.join(sandbox, "cloud-engine-namespace.c"),
            "-o",
            tree.physical(runtime.engineNamespace),
          ],
          { stdio: "pipe" },
        );
        chmodSync(tree.physical(runtime.engineNamespace), 0o500);
        // The scratch/mount layout supplied before preparing the engine view.
        // Its populated workspace stays
        // the only Files/managed-Git root; the selected clones are siblings.
        for (const directory of [
          "/srv/zeros/files/workspace",
          "/srv/zeros/files/state",
          "/srv/zeros/files/managed-settings",
          "/srv/zeros/files/home/agent",
          "/srv/zeros/files/home/capture",
          "/srv/zeros/home/agent",
          "/srv/zeros/home/capture",
        ])
          tree.mkdir(directory);
        tree.write("/srv/zeros/files/workspace/primary", "primary data", 0o644);
        tree.write("/srv/zeros/files/.zeros-setup/seed/private", "private setup seed", 0o600);
        chmodSync(tree.physical("/srv/zeros/files/.zeros-setup"), 0o710);
        tree.write(
          "/srv/zeros/managed-settings/settings.managed.toml",
          "",
          0o640,
        );
        chmodSync(tree.physical("/srv/zeros/managed-settings"),0o750);
        for (const name of ["policy.json", "registries.conf"])
          tree.write(`/etc/containers/${name}`, "{}");
        tree.write(
          "/opt/zeros-bootstrap/computer-build.py",
          readFileSync(helper, "utf8"),
          0o555,
        );
        tree.write("/usr/bin/rg", "fixture executable", 0o555);
        tree.write(`${runtime.workerRoot}/binaries/rg`, "fixture executable", 0o555);
        tree.write(`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`, "// pinned Host fixture", 0o444);
        tree.write("/origin/file", "repository data", 0o644);
        execFileSync("git", ["init", "--quiet", tree.physical("/origin")]);
        execFileSync("git", ["-C", tree.physical("/origin"), "add", "."]);
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "-C",
            tree.physical("/origin"),
            "commit",
            "--quiet",
            "-m",
            "fixture",
          ],
          { stdio: "pipe" },
        );
        // This is the real base helper with only the Git transport redirected
        // to a local repository. It retains production umask and UID ownership.
        tree.write(
          "/clone.py",
          `import importlib.util, os, pathlib, sys
spec=importlib.util.spec_from_file_location("computer_build", sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
os.chdir(sys.argv[2])
app=module.ComputerBuild(pathlib.Path("."))
git=app.git
def local_git(args, cwd, environment=None, timeout=60):
    args=[str(pathlib.Path("origin").resolve()) if item.startswith("https://github.com/") else item for item in args]
    return git(["-c", "protocol.file.allow=always", *args], cwd, environment, timeout)
app.git=local_git
os.umask(0o077)
app.clone_repos({"schema":"zeros.computer-repositories-input/v1", "buildId":"11111111-1111-4111-8111-111111111111", "workerFence":1,
    "repositories":[{"id":str(index+1),"owner":"fixture","name":"repo"+str(index),"ref":None,
    "credential":{"token":"synthetic-clone-credential","expiresAt":"2099-01-01T00:00:00Z"}} for index in range(${repositoryCount})]})
`,
        );
        tree.write(
          "/install.py",
          `import importlib.util, os, subprocess
spec=importlib.util.spec_from_file_location("computer_build", "/opt/zeros-bootstrap/computer-build.py")
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
args=module.SystemHost().install_command("11111111-1111-4111-8111-111111111111", 5)
script="test \\"$PWD\\" = /srv/zeros/repos\\n"
for index in range(${repositoryCount}):
    script+="cd /srv/zeros/repos/fixture/repo"+str(index)+"\\npwd > install-path\\n"
result=subprocess.run(args[args.index("/usr/bin/unshare"):], input=script.encode(), env=module.ENVIRONMENT,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
assert result.returncode == 0, "private install namespace failed"
failed=subprocess.run(args[args.index("/usr/bin/unshare"):], input=b"false | true\\nprintf unreachable\\n", env=module.ENVIRONMENT,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
assert failed.returncode != 0 and not failed.stdout, "strict Bash failure was lost"
assert not os.path.ismount("/srv/zeros/repos"), "build bind escaped its namespace"
assert not os.listdir("/srv/zeros/repos"), "logical mount target retained private build files"
assert os.path.exists("/srv/zeros/files/repos") == bool(${repositoryCount})
`,
        );
        tree.write(
          `${runtime.workerRoot}/projection-check.mjs`,
          `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
assert.equal(process.getuid(), 10003);
assert.equal(process.getgid(), 10003);
// Node includes the effective GID; procfs records supplementary groups.
assert.deepEqual(process.getgroups(), [10003]);
const status=fs.readFileSync('/proc/self/status','utf8');
assert.match(status,/^Groups:[\\t ]*$/m);
assert.match(status,/^NoNewPrivs:[\\t ]+1$/m);
for (const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])
  assert.match(status,new RegExp('^'+field+':[\\t ]+0+$','m'));
assert.equal(process.cwd(), '/srv/zeros/workspace');
assert.equal(fs.readFileSync('/srv/zeros/workspace/primary','utf8'), 'primary data');
for (const file of ['/home/user','/srv/zeros/setup','/srv/zeros/broker','/opt/zeros-bootstrap']) assert(!fs.existsSync(file));
assert(!fs.existsSync('/srv/zeros/.zeros-setup/seed/private'));
assert(!fs.existsSync('/srv/zeros/.zeros-engine-setup/seed/private'));
assert(!fs.existsSync('/srv/zeros/files/repos'));
for (const home of ['/srv/zeros/home/agent','/srv/zeros/home/capture']) {
  const metadata=fs.lstatSync(home);
  assert.equal(metadata.uid,10003);
  assert.equal(metadata.gid,10003);
}
for (let index=0; index<${repositoryCount}; index++) {
  const source="const fs=require('node:fs'); const p='/srv/zeros/repos/fixture/repo"+index+"'; " +
    "const metadata=fs.lstatSync(p); if(process.getuid()!==10003||process.getgid()!==10003||metadata.uid!==10003||metadata.gid!==10003||fs.readFileSync(p+'/file','utf8')!=='repository data'||fs.readFileSync(p+'/install-path','utf8').trim()!==p)process.exit(1); fs.writeFileSync(p+'/agent-write','ok'); const written=fs.lstatSync(p+'/agent-write'); if(written.uid!==10003||written.gid!==10003)process.exit(1)";
  const child=spawnSync(${JSON.stringify(runtime.node)},['-e',source],
    {encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
  assert.equal(child.status,0,'workspace identity cannot use secondary repository');
}
if (${repositoryCount} === 0) assert(!fs.existsSync('/srv/zeros/repos'));
process.stdout.write('template projection checked');
`,
        );
        tree.write(
          "/qualify.mjs",
          `
import {launchCloudEngine,prepareCloudEngineView} from '${runtime.libRoot}/cloud-engine-launcher.mjs';
import {cloudEngineViewArguments,cloudEngineViewEnvironment} from '${runtime.libRoot}/cloud-engine-view.mjs';
import {resolveCloudRuntime} from '${runtime.libRoot}/cloud-runtime-root.mjs';
import {adoptCloudEngineTree} from '${runtime.libRoot}/prepare-cloud-image-files.mjs';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const installed=spawnSync('/usr/bin/python3',['-B','/install.py'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'},timeout:15000});
if(installed.status!==0)throw new Error(installed.stderr);
const runtime=resolveCloudRuntime();
// This isolated fixture owns no delegated kernel scope. Keep the launcher's
// real outside-root refusal; do not manufacture placement or drain evidence.
await assert.rejects(launchCloudEngine({operation:'qualify',runtime,source:{},
  scope:{prepare(){throw new Error('unadmitted scope prepared');}}}),
  {message:'Cloud root monitor placement was refused'});
// The frozen computer-build helper still emits legacy-owned clones. Exercise
// the actual ownership adoption primitive on this fixture's unused files.
adoptCloudEngineTree('/srv/zeros/files/workspace');
if(fs.existsSync('/srv/zeros/files/repos'))adoptCloudEngineTree('/srv/zeros/files/repos');
${alteration}
const resourceProjection={version:1,resources:null,memoryBudget:{nominalMemoryBytes:null,
  measuredMemoryBytes:null,hostMemoryMax:'268435456',source:'fallback',capped:false}};
const prepare=()=>prepareCloudEngineView(runtime,{},'qualify',undefined,undefined,resourceProjection);
if (${JSON.stringify(error)}) {
  assert.throws(prepare,{message:${JSON.stringify(error)}});
  process.stdout.write('unsafe projection rejected');
} else {
  const profile=prepare();
  try {
    const args=cloudEngineViewArguments('qualify',profile.version,runtime,profile.viewDirectory);
    const entry=args.indexOf('--');
    assert.equal(args[entry+1],runtime.engineNamespace);
    // Check the production mounts with a fixture-only non-root reader. The
    // actual C entry requires original kernel custody, covered separately.
    const result=spawnSync('/usr/bin/bwrap',[...args.slice(0,entry),'--',
      '/usr/bin/setpriv','--reuid','10003','--regid','10003','--clear-groups',
      '--no-new-privs','--inh-caps','-all','--ambient-caps','-all','--bounding-set','-all',
      runtime.node,'${runtime.workerRoot}/projection-check.mjs'],
      {encoding:'utf8',env:cloudEngineViewEnvironment({},'qualify',runtime),timeout:15000});
    assert.equal(result.stderr,'');
    assert.equal(result.status,0);
    process.stdout.write(result.stdout);
  } finally {profile.releaseView();}
}
`,
        );
        execFileSync("sudo", [
          "-n",
          "/usr/bin/chown",
          "-hR",
          "0:0",
          tree.directory,
        ]);
        execFileSync("sudo", [
          "-n",
          "/usr/bin/chown",
          "0:10001",
          tree.physical("/srv/zeros/files/.zeros-setup"),
          tree.physical("/srv/zeros/managed-settings"),
        ]);
        execFileSync(
          "sudo",
          ["-n", "/usr/bin/python3", "-B", tree.physical("/clone.py"), helper, tree.directory],
          // Enter the root-owned 0700 fixture only after sudo has changed UID.
          { stdio: "pipe" },
        );
        execFileSync("sudo", [
          "-n",
          "/usr/bin/chown",
          "-hR",
          "10001:10001",
          tree.physical("/srv/zeros/files/workspace"),
        ]);
        const outer = [
          "--die-with-parent",
          "--unshare-pid",
          "--ro-bind",
          "/usr",
          "/usr",
          "--tmpfs",
          "/usr/bin",
          "--ro-bind",
          "/usr/bin/bwrap",
          "/usr/bin/bwrap",
          "--ro-bind",
          "/usr/bin/setpriv",
          "/usr/bin/setpriv",
          "--ro-bind",
          tree.physical("/usr/bin/rg"),
          "/usr/bin/rg",
          "--symlink",
          "usr/bin",
          "/bin",
          "--symlink",
          "usr/sbin",
          "/sbin",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib64",
          "/lib64",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--ro-bind",
          "/sys",
          "/sys",
          "--tmpfs",
          "/tmp",
        ];
        for (const name of ["python3", "unshare", "mount", "bash"])
          outer.push(
            "--ro-bind",
            realpathSync(`/usr/bin/${name}`),
            `/usr/bin/${name}`,
          );
        for (const name of [
          "passwd",
          "group",
          "nsswitch.conf",
          "hosts",
          "resolv.conf",
          "ssl",
          "ld.so.cache",
          "alternatives",
        ])
          outer.push("--ro-bind", realpathSync(`/etc/${name}`), `/etc/${name}`);
        for (const name of [
          "/opt",
          "/srv",
          "/run",
          "/etc/zeros",
          "/etc/containers",
        ])
          outer.push("--bind", tree.physical(name), name);
        outer.push(
          "--symlink",
          "/opt/zeros",
          "/zeros",
          "--ro-bind",
          tree.physical("/qualify.mjs"),
          "/qualify.mjs",
          "--ro-bind",
          tree.physical("/install.py"),
          "/install.py",
          "--chdir",
          "/",
          "--",
          runtime.node,
          "/qualify.mjs",
        );
        const result = spawnSync("sudo", ["-n", "/usr/bin/bwrap", ...outer], {
          env: { PATH: "/usr/bin:/bin" },
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 4096,
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(
          error
            ? "unsafe projection rejected"
            : "template projection checked",
        );
      } finally {
        execFileSync("sudo", [
          "-n",
          "/usr/bin/chown",
          "-hR",
          `${process.getuid!()}:${process.getgid!()}`,
          tree.directory,
        ]);
        tree.dispose();
      }
    },
    30_000,
  );
});
