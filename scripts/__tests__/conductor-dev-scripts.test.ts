import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace, writePrivateJson } from "../dev-environment/state.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
const scripts = parse(
  fs.readFileSync(path.join(repository, ".conductor/settings.toml"), "utf8"),
).scripts as {
  setup: string;
  archive: string;
  run: Record<string, { command: string; available_in: string[] }>;
};
const directories: string[] = [];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(current = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-dev-"));
  directories.push(directory);
  const home = path.join(directory, "home");
  const tools = path.join(home, ".zeros-dev/tools/bin");
  const broken = path.join(directory, "broken-bin");
  const root = path.join(directory, "checkout");
  const log = path.join(directory, "commands.log");
  fs.mkdirSync(tools, { recursive: true });
  fs.mkdirSync(broken);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(broken, "node"), "#!/bin/sh\nexit 86\n", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(directory, "version.cjs"), 'Object.defineProperty(process.versions, "node", {value: process.env.ZEROS_TEST_NODE_VERSION || "22.18.0"});');
  fs.writeFileSync(
    path.join(tools, "node"),
    `#!/bin/sh\nexec ${quote(process.execPath)} -r ${quote(path.join(directory, "version.cjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  for (const command of ["pnpm", "npm"]) {
    fs.writeFileSync(
      path.join(tools, command),
      `#!/bin/sh\nnode -e 'process.exit(0)' || exit 87\nprintf '%s\\n' '${command} '"$*" >> "$ZEROS_SCRIPT_TEST_LOG"\nexit "\${ZEROS_SCRIPT_TEST_EXIT:-0}"\n`,
      { mode: 0o755 },
    );
  }
  if (current) {
    fs.mkdirSync(path.join(root, "scripts/dev-environment"), { recursive: true });
    for (const file of ["hook.sh", "toolchain.sh"]) fs.copyFileSync(path.join(repository, "scripts/dev-environment", file), path.join(root, "scripts/dev-environment", file));
    fs.writeFileSync(path.join(root, "scripts/dev-environment/dependencies.mjs"), `
      import { spawnSync } from 'node:child_process';
      if (process.argv[2] !== '--install') process.exit(88);
      for (const [command, ...args] of [['pnpm', 'install', '--frozen-lockfile'], ['pnpm', '--dir', 'apps/control-plane', 'install', '--frozen-lockfile'], ['npm', '--prefix', 'apps/web', 'ci']]) {
        const result = spawnSync(command, args, { stdio: 'inherit' });
        if (result.status !== 0) process.exit(result.status ?? 1);
      }
    `);
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        "electron:dev": "local desktop",
        ...(current ? { "electron:cloud": "node scripts/electron-cloud.mjs" } : {}),
      },
    }),
  );
  return {
    root,
    home,
    log: () =>
      fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
    run: (command: string, exit = 0, nodeVersion = "22.18.0", extraEnv: Record<string, string> = {}) =>
      spawnSync("/bin/bash", ["-c", command], {
        cwd: root,
        env: {
          HOME: home,
          PATH: `${broken}:/usr/bin:/bin`,
          ZEROS_SCRIPT_TEST_LOG: log,
          ZEROS_TEST_NODE_VERSION: nodeVersion,
          ZEROS_SCRIPT_TEST_EXIT: String(exit),
          ...extraEnv,
        },
        encoding: "utf8",
      }),
  };
}

function localCloudFixture(env: Record<string, string> = {}) {
  const f = fixture(false);
  const workspace = ensureWorkspace({ repositoryRoot: f.root, homeDir: f.home, env });
  fs.mkdirSync(path.join(f.root, "scripts/dev-environment"), { recursive: true });
  fs.copyFileSync(path.join(repository, "scripts/dev-environment/toolchain.sh"), path.join(f.root, "scripts/dev-environment/toolchain.sh"));
  fs.writeFileSync(path.join(f.root, "scripts/electron-cloud.mjs"), "");
  const pkg = JSON.parse(fs.readFileSync(path.join(f.root, "package.json"), "utf8"));
  pkg.scripts["electron:cloud"] = "node scripts/electron-cloud.mjs";
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify(pkg));
  const reset = path.join(f.root, "reset.cjs");
  fs.writeFileSync(reset, `
    const fs = require('node:fs');
    const file = ${JSON.stringify(workspace.file)};
    if (process.env.ZEROS_RESET_MODE === 'unconfirmed') process.exit(0);
    if (process.env.ZEROS_RESET_MODE === 'missing') { fs.unlinkSync(file); process.exit(0); }
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.status = 'archived';
    if (process.env.ZEROS_RESET_MODE === 'replaced') state.instanceId = require('node:crypto').randomUUID();
    fs.writeFileSync(file, JSON.stringify(state));
  `);
  const pnpm = path.join(f.home, ".zeros-dev/tools/bin/pnpm");
  fs.writeFileSync(pnpm, fs.readFileSync(pnpm, "utf8").replace('exit "${ZEROS_SCRIPT_TEST_EXIT:-0}"',
    `if [ "\${ZEROS_SCRIPT_TEST_EXIT:-0}" = 0 ] && [ "$*" = 'electron:cloud --reset --yes' ]; then node ${quote(reset)} || exit $?; fi\nexit "\${ZEROS_SCRIPT_TEST_EXIT:-0}"`));
  return { ...f, workspace };
}

describe("Conductor electron:cloud archive", () => {
  it("confirms the owned reset", () => {
    const f = localCloudFixture();
    const result = f.run(scripts.archive);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toEqual(["pnpm electron:cloud --reset --yes"]);
    expect(JSON.parse(fs.readFileSync(f.workspace.file, "utf8")).status).toBe("archived");
  });

  it("preserves a failed drain", () => {
    const f = localCloudFixture(), before = fs.readFileSync(f.workspace.file, "utf8");
    expect(f.run(scripts.archive, 23).status).toBe(23);
    expect(f.log()).toEqual(["pnpm electron:cloud --reset --yes"]);
    expect(fs.readFileSync(f.workspace.file, "utf8")).toBe(before);
  });

  it.each(["unconfirmed", "missing", "replaced"])("requires the same instance's archived receipt after reset: %s", mode => {
    const f = localCloudFixture();
    const result = f.run(scripts.archive, 0, "22.18.0", { ZEROS_RESET_MODE: mode });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cleanup.*unconfirmed/i);
    expect(f.log()).toEqual(["pnpm electron:cloud --reset --yes"]);
  });

  it.each(["owner", "identity", "instanceId", "status"])("refuses a malformed or foreign %s without resetting", field => {
    const f = localCloudFixture();
    writePrivateJson(f.workspace.file, { ...f.workspace.state, [field]: "foreign" });
    const result = f.run(scripts.archive);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cleanup.*unconfirmed/i);
    expect(f.log()).toEqual([]);
  });

  it.each(["receipt", "parent"])("refuses linked local state: %s", entry => {
    const f = localCloudFixture();
    const original = entry === "receipt" ? f.workspace.file : f.workspace.directory;
    fs.renameSync(original, `${original}-saved`);
    fs.symlinkSync(`${original}-saved`, original);
    expect(f.run(scripts.archive).status).not.toBe(0);
    expect(f.log()).toEqual([]);
  });

  it("refuses a non-private receipt", () => {
    const f = localCloudFixture();
    fs.chmodSync(f.workspace.file, 0o644);
    expect(f.run(scripts.archive).status).not.toBe(0);
    expect(f.log()).toEqual([]);
  });

  it("retries an interrupted reset and skips a positively archived instance", () => {
    const f = localCloudFixture();
    writePrivateJson(f.workspace.file, { ...f.workspace.state, status: "archiving" });
    expect(f.run(scripts.archive).status).toBe(0);
    fs.rmSync(path.join(f.home, ".zeros-dev/tools/bin/node"));
    expect(f.run(scripts.archive).status).toBe(0);
    expect(f.log()).toEqual(["pnpm electron:cloud --reset --yes"]);
  });

  it.each(["scripts/electron-cloud.mjs", "scripts/dev-environment/toolchain.sh", "package.json"])("blocks an old branch with owned state but without %s", file => {
    const f = localCloudFixture();
    fs.rmSync(path.join(f.root, file));
    const result = f.run(scripts.archive);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/branch.*electron:cloud/i);
    expect(f.log()).toEqual([]);
  });

  it.each(["zeros", "conductor", "inherited"])("matches the launcher's root-checked identity: %s", manager => {
    const f = localCloudFixture();
    const prefix = manager === "zeros" ? "ZEROS" : "CONDUCTOR";
    const env: Record<string, string> = prefix === "ZEROS" ? { ZEROS_WORKSPACE_CANONICAL_ID: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", ZEROS_WORKSPACE_ROOT: f.root }
      : { CONDUCTOR_WORKSPACE_ID: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", CONDUCTOR_WORKSPACE_PATH: manager === "inherited" ? f.home : f.root };
    const selected = ensureWorkspace({ repositoryRoot: f.root, homeDir: f.home, env });
    // The fake reset writes the selected receipt, just as the real launcher does.
    const reset = path.join(f.root, "reset.cjs");
    fs.writeFileSync(reset, fs.readFileSync(reset, "utf8").replace(JSON.stringify(f.workspace.file), JSON.stringify(selected.file)));
    expect(f.run(scripts.archive, 0, "22.18.0", env).status).toBe(0);
    expect(f.log()).toEqual(["pnpm electron:cloud --reset --yes"]);
    expect(JSON.parse(fs.readFileSync(selected.file, "utf8")).status).toBe("archived");
    if (selected.file !== f.workspace.file) expect(JSON.parse(fs.readFileSync(f.workspace.file, "utf8")).status).toBe("active");
  });

  it("does not reset another checkout's instance", () => {
    const f = localCloudFixture();
    const other = path.join(path.dirname(f.root), "other"); fs.mkdirSync(other);
    const result = f.run(`cd ${quote(other)}\n${scripts.archive}`);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(f.workspace.file, "utf8")).status).toBe("active");
  });
});

describe("Conductor Dev actions", () => {
  it("selects qualified tools for Local without invoking Dev setup or hooks", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root,"package.json"),JSON.stringify({scripts:{"electron:local":"node scripts/electron-local.mjs"}}));
    fs.writeFileSync(path.join(f.root,"scripts/electron-local.mjs"), "");
    fs.writeFileSync(path.join(f.root,"scripts/dev-environment/hook.sh"),"exit 91\n");
    fs.writeFileSync(path.join(f.root,"scripts/dev-environment/setup.mjs"),"process.exit(92);\n");
    const result=f.run(scripts.run["Zeros Local"].command);
    expect(result.status,result.stderr).toBe(0);
    expect(f.log()).toEqual(["pnpm electron:local"]);
    expect(scripts.run["Zeros Local"].available_in).toEqual(["local"]);
    expect(scripts.run["Zeros Local"]).not.toHaveProperty("default");
  });

  it("explains the Local entry on branches that predate the package command", () => {
    const f=fixture();
    const result=f.run(scripts.run["Zeros Local"].command);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("This branch predates Zeros Local; rebase onto main or use Dev.");
    expect(f.log()).toEqual([]);
  });

  describe.each(["/bin/sh", "/bin/zsh"])("Local action under %s", (shell) => {
    it.skipIf(!fs.existsSync(shell))("selects qualified Node available only on PATH", () => {
      const f = fixture();
      const tools = path.join(f.home, ".zeros-dev/tools/bin");
      const bin = path.join(f.root, "nvm/bin");
      const selected = path.join(f.root, "selected-node");
      fs.mkdirSync(bin, { recursive: true });
      fs.copyFileSync(path.join(tools, "node"), path.join(bin, "node"));
      fs.writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\nnode -e 'process.exit(0)' || exit 87\ncommand -v node > ${quote(selected)}\n`, {mode: 0o755});
      fs.rmSync(tools, { recursive: true });
      fs.writeFileSync(path.join(f.root, "scripts/electron-local.mjs"), "");
      fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({scripts:{"electron:local":"node scripts/electron-local.mjs"}}));
      const result = spawnSync(shell, ["-c", scripts.run["Zeros Local"].command], {
        cwd: f.root, env: { HOME: f.home, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(selected, "utf8").trim()).toBe(path.join(bin, "node"));
    });
    it.skipIf(!fs.existsSync(shell))("explains an older branch without requiring Node", () => {
      const f = fixture();
      fs.rmSync(path.join(f.home, ".zeros-dev/tools/bin"), {recursive:true});
      const result = spawnSync(shell, ["-c", scripts.run["Zeros Local"].command], {
        cwd:f.root, env: {HOME:f.home,PATH:"/usr/bin:/bin"}, encoding:"utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("This branch predates Zeros Local; rebase onto main or use Dev.");
    });
  });

  it("fails setup before installing dependencies when the available importer reports a profile problem", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "scripts/dev-environment/setup.mjs"), "console.error('Supply a private profile');process.exit(33);");
    const result = f.run(scripts.setup);
    expect(result.status).toBe(33); expect(f.log()).toEqual([]);
  });
  it("installs all dependency roots with the working toolchain despite a broken inherited Node", () => {
    const f = fixture();
    const result = f.run(scripts.setup);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm --dir apps/control-plane install --frozen-lockfile",
      "npm --prefix apps/web ci",
    ]);
  });

  it("installs qualified Node during Linux setup when the cloud VM only supplies Node 24", () => {
    const f = fixture();
    const installedNode = path.join(f.home, ".zeros-dev/tools/bin/node");
    const replacement = fs.readFileSync(installedNode, "utf8").replace("exec ", "export ZEROS_TEST_NODE_VERSION=22.18.0\nexec ");
    const bootstrap = path.join(path.dirname(f.home), "broken-bin/npm");
    fs.writeFileSync(path.join(path.dirname(bootstrap), "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(bootstrap, `#!/bin/sh\nprintf '%s\\n' 'bootstrap '"$*" >> "$ZEROS_SCRIPT_TEST_LOG"\nprintf '%s' ${quote(replacement)} > ${quote(installedNode)}\n`, { mode: 0o755 });
    const result = f.run(scripts.setup, 0, "24.14.1");
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()[0]).toContain("node@22");
    expect(f.log().slice(1)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm --dir apps/control-plane install --frozen-lockfile",
      "npm --prefix apps/web ci",
    ]);
    expect(f.run(scripts.setup, 0, "24.14.1").status).toBe(0);
    expect(f.log().filter(line => line.startsWith("bootstrap "))).toHaveLength(1);
  });

  it("stops Linux setup before dependency installation when Node bootstrap fails", () => {
    const f = fixture();
    fs.writeFileSync(path.join(path.dirname(f.home), "broken-bin/uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(path.join(path.dirname(f.home), "broken-bin/npm"), "#!/bin/sh\nexit 43\n", { mode: 0o755 });
    const result = f.run(scripts.setup, 0, "24.14.1");
    expect(result.status).toBe(43);
    expect(f.log()).toEqual([]);
  });

  it("does not call a missing profile importer on older Local-only checkouts", () => {
    const f = fixture(false);
    fs.writeFileSync(path.join(f.root, "zeros-dev-env.json"), "{}");
    const result = f.run(scripts.setup);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toHaveLength(3);
  });

  it("runs Zeros Dev on the Mac and its headless backend in the cloud", () => {
    const f = fixture();
    const local = Object.values(scripts.run).find((entry) =>
      entry.available_in.includes("local"),
    )!;
    const cloud = Object.values(scripts.run).find((entry) =>
      entry.available_in.includes("cloud"),
    )!;
    expect(f.run(local.command).status).toBe(0);
    expect(f.run(cloud.command).status).toBe(0);
    expect(f.log()).toEqual(["pnpm electron:cloud", "pnpm electron:cloud --headless"]);
    expect(scripts.run["Zeros Dev"].available_in).toEqual(["local"]);
    expect(scripts.run["Zeros Dev backend"].available_in).toEqual(["cloud"]);
  });
});

it("embeds the same portable archive guard into the remote shared settings", () => {
  expect(scripts.archive.trim()).toBe(fs.readFileSync(path.join(repository, "scripts/dev-environment/archive-hook.sh"), "utf8").trim());
});
describe("archive without Dev state", () => {
  it("archives a checkout without Dev state", () => {
    const f = fixture(false), result = f.run(scripts.archive);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toEqual([]);
  });
  it("does not require Node to archive an unbound Local-only checkout", () => {
    const f = fixture(false);
    fs.rmSync(path.join(f.home, ".zeros-dev/tools/bin/node"));
    expect(f.run(scripts.archive).status).toBe(0);
  });
  it("does not require Node for a current checkout without local cloud state", () => {
    const f = fixture();
    fs.rmSync(path.join(f.home, ".zeros-dev/tools/bin/node"));
    const result = f.run(scripts.archive);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toEqual([]);
  });
});

it.each(["21.9.0", "22.17.0", "23.0.0", "25.0.0"])("rejects unqualified Node %s before a Dev hook runs", version => {
  const f = fixture();
  expect(f.run(scripts.run["Zeros Dev"].command, 0, version).status).not.toBe(0);
  expect(f.log()).toEqual([]);
});
