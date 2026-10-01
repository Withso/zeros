import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

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

function fixture(hosted = true) {
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
  if (hosted) {
    fs.mkdirSync(path.join(root, "scripts/dev-environment"), { recursive: true });
    for (const file of ["hook.sh", "toolchain.sh"]) fs.copyFileSync(path.join(repository, "scripts/dev-environment", file), path.join(root, "scripts/dev-environment", file));
    fs.writeFileSync(path.join(root, "scripts/dev-environment/hosted-launcher.mjs"), "");
    fs.mkdirSync(path.join(root, ".context/zeros-dev"), { recursive: true });
    fs.writeFileSync(path.join(root, ".context/zeros-dev/owner.json"), "{}");
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        "electron:dev": "local desktop",
        ...(hosted
          ? { "dev:backend": "hosted backend", "dev:archive": "hosted cleanup" }
          : {}),
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

describe("Conductor Dev actions", () => {
  it("fails setup before installing dependencies when the available importer reports missing hosted credentials", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "scripts/dev-environment/setup.mjs"), "console.error('Supply a private hosted profile');process.exit(33);");
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

  it("runs this checkout's desktop locally and its backend in the cloud", () => {
    const f = fixture();
    const local = Object.values(scripts.run).find((entry) =>
      entry.available_in.includes("local"),
    )!;
    const cloud = Object.values(scripts.run).find((entry) =>
      entry.available_in.includes("cloud"),
    )!;
    expect(f.run(local.command).status).toBe(0);
    expect(f.run(cloud.command).status).toBe(0);
    expect(f.log()).toEqual(["pnpm electron:dev", "pnpm dev:backend"]);
  });

  it("retains cleanup failure so archive cannot silently leave hosted resources", () => {
    const f = fixture();
    expect(f.run(scripts.archive, 23).status).toBe(23);
    expect(f.log()).toEqual(["pnpm dev:archive"]);
  });

  it("explains why a checkout without hosted cleanup cannot confirm archive", () => {
    const f = fixture(false);
    fs.mkdirSync(path.join(f.root, ".context/zeros-dev"), { recursive: true });
    fs.writeFileSync(path.join(f.root, ".context/zeros-dev/owner.json"), "{}");
    const result = f.run(scripts.archive);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dev:archive");
    expect(f.log()).toEqual([]);
  });
});

it("embeds the same portable archive guard into the remote shared settings", () => {
  expect(scripts.archive.trim()).toBe(fs.readFileSync(path.join(repository, "scripts/dev-environment/archive-hook.sh"), "utf8").trim());
});
it.each([200, 404, 403])("authenticates legacy archive discovery before interpreting HTTP %i", status => {
  const f = fixture(false), profile = path.join(f.root, "zeros-dev-env.json");
  fs.writeFileSync(profile, JSON.stringify({ registry: { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "zeros-dev-registry",
    accessKeyId: "synthetic", secretAccessKey: "synthetic" } }), { mode: 0o600 });
  const source = scripts.archive.split("ZEROS_DEV_REGISTRY_PROBE' || zeros_dev_probe_status=$?\n")[1].split("\nZEROS_DEV_REGISTRY_PROBE")[0];
  const test = `${source}\ntry:\n    result=probe(${JSON.stringify(profile)}, lambda key: 200 if not key else ${status})\nexcept Exception:\n    result=1\nprint(result)\n`;
  const result = spawnSync("python3", ["-c", `__name__='test'\n${test}`], { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.home }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(String(status === 200 ? 10 : status === 404 ? 0 : 1));
});

it.each([200, 404, 403])("uses injected cloud credentials for Node-free archive discovery at HTTP %i", status => {
  const f = fixture(false);
  const profile = { version: 2, mode: "hosted", registry: { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
    bucket: "zeros-dev-registry", accessKeyId: "synthetic", secretAccessKey: "synthetic" } };
  const source = scripts.archive.split("ZEROS_DEV_REGISTRY_PROBE' || zeros_dev_probe_status=$?\n")[1].split("\nZEROS_DEV_REGISTRY_PROBE")[0];
  const test = `${source}\ntry:\n    result=probe('', lambda key: 200 if not key else ${status})\nexcept Exception:\n    result=1\nprint(result)\n`;
  const result = spawnSync("python3", ["-c", `__name__='test'\n${test}`], { cwd: f.root,
    env: { PATH: process.env.PATH, HOME: f.home, ZEROS_DEV_PROFILE_B64: Buffer.from(JSON.stringify(profile)).toString("base64") }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(String(status === 200 ? 10 : status === 404 ? 0 : 1));
});

describe("shared hooks on old branches", () => {
  it("does not assume absence when an old cloud checkout has only an injected profile", () => {
    const f = fixture(false), bin = path.join(f.home, ".zeros-dev/tools/bin");
    fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\nexit 10\n", { mode: 0o755 });
    const result = f.run(`export PATH=${quote(bin)}:$PATH\n${scripts.archive}`, 0, "22.18.0", { ZEROS_DEV_PROFILE_B64: "synthetic-profile" });
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/receipt|dev:archive/);
    expect(f.log()).toEqual([]);
  });
  it("archives an old Local-only checkout without hosted state", () => {
    const f = fixture(false), result = f.run(scripts.archive);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/nothing|no hosted/i);
    expect(f.log()).toEqual([]);
  });
  it("does not require Node to archive an unbound Local-only checkout", () => {
    const f = fixture(false);
    fs.rmSync(path.join(f.home, ".zeros-dev/tools/bin/node"));
    expect(f.run(scripts.archive).status).toBe(0);
  });
  it("does not require Node for a current checkout with no binding or provisioning profile", () => {
    const f = fixture();
    fs.rmSync(path.join(f.root, ".context/zeros-dev/owner.json"));
    fs.rmSync(path.join(f.home, ".zeros-dev/tools/bin/node"));
    const result = f.run(scripts.archive);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toEqual([]);
  });
  it("uses authenticated legacy registry discovery before accepting absence on an old branch", () => {
    const f = fixture(false);
    fs.writeFileSync(path.join(f.root, "zeros-dev-env.json"), "{}", { mode: 0o600 });
    // Fake the portable read-only registry probe, without Node or providers.
    const bin = path.join(f.home, ".zeros-dev/tools/bin");
    fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\nexit 10\n", { mode: 0o755 });
    const result = f.run(`export PATH=${quote(bin)}:$PATH\n${scripts.archive}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/receipt|cleanup|dev:archive/i);
  });
  it("requires confirmed cleanup when the private binding survived a branch switch", () => {
    const f = fixture(false);
    fs.mkdirSync(path.join(f.root, ".context/zeros-dev"), { recursive: true });
    fs.writeFileSync(path.join(f.root, ".context/zeros-dev/owner.json"), "{}");
    const result = f.run(scripts.archive);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/branch.*dev:archive|dev:archive.*branch/i);
  });
});


it.each(["21.9.0", "22.17.0", "23.0.0", "25.0.0"])("rejects unqualified Node %s before a hosted hook runs", version => {
  const f = fixture();
  expect(f.run(scripts.archive, 0, version).status).not.toBe(0);
  expect(f.log()).toEqual([]);
});
