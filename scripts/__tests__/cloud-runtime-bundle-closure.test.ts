import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPathPrefixes,
  diagnostic,
} from "../cloud-workspace-validation/runtime-bundle/build";
import { buildEnvironment } from "../cloud-workspace-validation/runtime-bundle/toolchain";
import {
  stageDependencyClosure,
  stageSources,
  scanPayload,
  RUNTIME_HELPERS,
  ROOT_METADATA,
  SOURCE_SLICES,
  SOURCE_FILES,
} from "../cloud-workspace-validation/runtime-bundle/closure";
import {
  canonicalJson,
  createManifest,
  inventoryTree,
} from "../cloud-workspace-validation/runtime-bundle/manifest";

const temporary: string[] = [];
const hostSources = ["host-process-supervisor.mjs", "cloud-host-workload-entry.mjs", "cloud-workload-cgroup.mjs",
  "cloud-runner-base.mjs", "cloud-runner-manager.mjs", "cloud-agent-runner.mjs", "cloud-runner-transport.mjs"]
  .map(name => `apps/desktop/src/engine/agents/containment/${name}`);
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-closure-unit-"));
  temporary.push(root);
  return root;
}
async function json(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value));
}
async function link(from: string, to: string) {
  await mkdir(path.dirname(to), { recursive: true });
  await symlink(path.relative(path.dirname(to), from), to);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function hostAssetProbe(options: { missing?: string; invalid?: string; native?: "missing" | "failed" } = {}) {
  const root = await directory(), worker = path.join(root, "worker");
  for (const source of hostSources) {
    const target = path.join(worker, source);
    await mkdir(path.dirname(target), { recursive: true });
    if (options.missing !== source) await writeFile(target,
      options.invalid === source ? "export const = INVALID_SYNTAX_SENTINEL;" : await readFile(source));
  }
  await json(path.join(worker, "package.json"), {});
  await json(path.join(root, "manifest.json"), {});
  await mkdir(path.join(root, "bin"));
  await writeFile(path.join(root, "bin/cloud-engine-namespace"), "fixture");
  if (options.native !== "missing") await writeFile(path.join(root, "bin/cloud-runner-bus"), options.native === "failed" ? "#!/bin/sh\nexit 70\n" :
    '#!/bin/sh\nprintf \'{"schema":"zeros.cloud-runner-native/v1","linked":true}\\n\'\n', { mode: 0o555 });
  await mkdir(path.join(worker, "binaries"));
  await writeFile(path.join(worker, "binaries/rg"), '#!/bin/sh\nprintf "ripgrep fixture\\n"\n', { mode: 0o555 });
  const source = await readFile("scripts/cloud-workspace-validation/runtime-bundle/probe.cjs", "utf8");
  const module = { exports: undefined as unknown };
  const require = createRequire(import.meta.url);
  const output: string[] = [];
  let exitCode: number | undefined;
  // Explicit process/rg fixtures; real Node syntax checks only. This never
  // invokes the namespace helper or self-entry and qualifies no kernel facts.
  const fixtureRequire = (name: string) => name === "node:child_process" ? {
    execFileSync: (binary: string, args: string[], options: object) =>
      execFileSync(binary === path.join(root, "bin/node") ? process.execPath : binary, args, options),
  } : require(name);
  runInNewContext(source.replace("Object.entries(checks)", "Object.entries({ host_assets: checks.host_assets })") +
    "\nmodule.exports = main;", { require: fixtureRequire, module,
    process: { argv: ["node", "probe.cjs", root, "engine"], env: { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin" },
      stdout: { write: (line: string) => output.push(line) }, exit: (code: number) => { exitCode = code; } } });
  await (module.exports as () => Promise<void>)();
  return { exitCode, output: output.join(""), diagnostic: JSON.parse(output.at(-1)!) };
}

describe("cloud Host staged entry closure (portable syntax/existence only)", () => {
  it("checks all original Host/self-entry/kernel module syntax plus neutral rg", async () => {
    const result = await hostAssetProbe();
    expect(result).toMatchObject({ exitCode: 0, diagnostic: { ok: true, failedChecks: [] } });
  });
  it.each(hostSources.slice(1))("refuses missing staged %s without leaking details", async missing => {
    const result = await hostAssetProbe({ missing });
    expect(result).toMatchObject({ exitCode: 1, diagnostic: { ok: false, failedChecks: ["host_assets"] } });
  });
  it.each(hostSources.slice(1))("refuses invalid staged %s without leaking source bytes", async invalid => {
    const result = await hostAssetProbe({ invalid });
    expect(result).toMatchObject({ exitCode: 1, diagnostic: { ok: false, failedChecks: ["host_assets"] } });
    expect(result.output).not.toContain("INVALID_SYNTAX_SENTINEL");
  });
  it.each(["missing", "failed"] as const)("refuses %s native runner library closure", async native => {
    const result = await hostAssetProbe({ native });
    expect(result).toMatchObject({ exitCode: 1, diagnostic: { ok: false, failedChecks: ["host_assets"] } });
  });
});

it.each(["loaded", "missing_dependency", "missing_export"])("probes full source engine import before publication: %s", async outcome => {
  const root = await directory();
  await json(path.join(root, "manifest.json"), {});
  const source = await readFile("scripts/cloud-workspace-validation/runtime-bundle/probe.cjs", "utf8");
  const module = { exports: undefined as unknown }, require = createRequire(import.meta.url);
  const output: string[] = [];
  let exitCode: number | undefined;
  const imports: string[] = [];
  const fromWorker = (name: string) => {
    imports.push(name);
    if (!name.endsWith("/zeros-engine.ts")) return {};
    if (outcome === "missing_dependency") throw new Error("PRIVATE_ENGINE_IMPORT_DETAIL");
    return outcome === "loaded" ? { ZerosEngine: class {} } : {};
  };
  // Real probe and diagnostic loop, with only module loading replaced. The
  // separate staged-source test exercises the actual transitive imports.
  runInNewContext(source.replace("Object.entries(checks)", "Object.entries({ qualification_imports: checks.qualification_imports })") +
    "\nmodule.exports = main;", { module, require: (name: string) => name === "node:module" ? { createRequire: () => fromWorker } : require(name),
    process: { argv: ["node", "probe.cjs", root, "engine"], env: { HOME: path.join(root, "home") },
      stdout: { write: (line: string) => output.push(line) }, exit: (code: number) => { exitCode = code; } } });
  await (module.exports as () => Promise<void>)();
  expect({ exitCode, diagnostic: JSON.parse(output.at(-1)!) }).toMatchObject(outcome === "loaded"
    ? { exitCode: 0, diagnostic: { ok: true, failedChecks: [] } }
    : { exitCode: 1, diagnostic: { ok: false, failedChecks: ["qualification_imports"] } });
  expect(imports).toContain(path.join(root, "worker/apps/desktop/src/engine/zeros-engine.ts"));
  expect(output.join("")).not.toContain("PRIVATE_ENGINE_IMPORT_DETAIL");
});

it("binds both offline phases to engine10003 and the exact pinned Host marker without nesting Cursor userns", async () => {
  const root = await directory();
  for (const relative of ["bin/node", "bin/start-engine.sh", "lib/zeros/setup-cloud-workspace.mjs", "lib/zeros/cloud-worker-supervisor.mjs"]) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, "fixture");
  }
  await writeFile(path.join(root, "manifest.json"), canonicalJson(createManifest({ source: { commit: "a".repeat(40), lockfileSha256: "b".repeat(64) },
    engineProtocolVersion: 43, agents: { claude: { sdk: "1", cli: "1" }, codex: { package: "1" }, cursor: { sdk: "1" } } }, await inventoryTree(root))));
  const tools = await import("../cloud-workspace-validation/runtime-bundle/toolchain");
  const scopes: string[] = [];
  vi.spyOn(tools, "runTool").mockImplementation(async (command, args) => {
    expect(command).toBe("setpriv");
    expect(args.filter(arg => arg === "--unshare-user")).toHaveLength(1);
    expect(args[args.indexOf("--uid") + 1]).toBe("10003");
    expect(args[args.indexOf("--gid") + 1]).toBe("10003");
    const target = args.indexOf("/etc/zeros/cloud-worker.json");
    const marker = JSON.parse(await readFile(args[target - 1], "utf8"));
    expect(marker).toEqual({ backend: "cloud-worker", uid: 10003, gid: 10003, profile: "zeros-cloud-worker-v4", version: 4,
      toolchain: { node: `${args.at(-2)}/bin/node`, supervisor: `${args.at(-2)}/worker/${hostSources[0]}` } });
    const phase = args.at(-1)!;
    scopes.push(phase);
    return JSON.stringify({ checks: [phase === "cursor" ? "cursor_load" : "node_abi"] }) + "\n" +
      JSON.stringify({ component: "bundle", ok: true, failedChecks: [] });
  });
  const { runClosureProbes } = await import("../cloud-workspace-validation/runtime-bundle/probe");
  await expect(runClosureProbes(root)).resolves.toMatchObject({ checks: ["node_abi", "cursor_load"], isolation: "mount_namespace_no_network" });
  expect(scopes).toEqual(["engine", "cursor"]);
});

describe("pnpm runtime closure", () => {
  it("stages only the selected cloud package roots while retaining late transitive data", async () => {
    const temp = await directory(), source = path.join(temp, "source"), runtime = path.join(temp, "runtime");
    await json(path.join(source, "package.json"), {
      dependencies: { engine: "1", "desktop-renderer": "1" },
      optionalDependencies: { "desktop-native": "1" },
    });
    for (const name of ["engine", "late-data", "desktop-renderer", "desktop-native"]) {
      const pkg = path.join(source, "node_modules", name);
      await json(path.join(pkg, "package.json"), { name, version: "1", main: "index.cjs",
        ...(name === "engine" ? { dependencies: { "late-data": "1" } } : {}) });
      await writeFile(path.join(pkg, "LICENSE"), `${name} notice\n`);
      await writeFile(path.join(pkg, "index.cjs"), name === "engine"
        ? 'module.exports = () => require("late-data");\n'
        : 'module.exports = require("node:fs").readFileSync(require("node:path").join(__dirname, "data.txt"), "utf8");\n');
      await writeFile(path.join(pkg, "data.txt"), `${name} payload`);
    }
    const packages = await stageDependencyClosure(source, runtime, {
      harnessRoots: [], productionRoots: ["engine"],
    });
    expect(packages.map(entry => entry.name).sort()).toEqual(["engine", "late-data"]);
    await rm(source, { recursive: true });
    expect(execFileSync(process.execPath,
      ["-e", "process.stdout.write(require(process.argv[1])())", path.join(runtime, "worker/node_modules/engine")],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } })).toBe("late-data payload");
    expect(await readFile(path.join(runtime, "worker/node_modules/late-data/LICENSE"), "utf8"))
      .toBe("late-data notice\n");
  });

  it("retains selected source and helper files without the desktop renderer or source tests", async () => {
    const temp = await directory(), source = path.join(temp, "source"), runtime = path.join(temp, "runtime");
    const engine = "apps/desktop/src/engine/zeros-engine.ts";
    const renderer = "apps/desktop/src/renderer/renderer.tsx";
    const test = "apps/desktop/src/engine/__tests__/unused.test.ts";
    for (const slice of SOURCE_SLICES) await mkdir(path.join(source, slice), { recursive: true });
    for (const relative of new Set([...ROOT_METADATA, ...SOURCE_FILES,
      ...RUNTIME_HELPERS.filter(helper => !helper.optional).map(helper => helper.source),
      ...hostSources, engine, renderer, test, "scripts/cloud-workspace-validation/sandbox/start-engine.sh"])) {
      await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      await writeFile(path.join(source, relative), "fixture");
    }
    await stageSources(source, runtime, { sourceFiles: [engine, ...hostSources] });
    expect(await readFile(path.join(runtime, "worker", engine), "utf8")).toBe("fixture");
    await expect(lstat(path.join(runtime, "worker", renderer))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(runtime, "worker", test))).rejects.toMatchObject({ code: "ENOENT" });
    for (const helper of RUNTIME_HELPERS.filter(helper => !helper.optional))
      expect((await lstat(path.join(runtime, helper.target))).isFile()).toBe(true);
  });

  it("stages every transitive engine source import outside apps/desktop/src", async () => {
    // Bundling discovers eager and lazy source edges without executing native
    // modules. Bare packages belong to stageDependencyClosure instead.
    const { metafile } = await build({
      entryPoints: ["apps/desktop/src/engine/zeros-engine.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const imports = Object.keys(metafile.inputs)
      .filter(filename => !filename.startsWith("apps/desktop/src/"));
    expect(imports.length).toBeGreaterThan(0);
    const unstaged = imports.filter(filename =>
      !SOURCE_FILES.includes(filename) && !ROOT_METADATA.includes(filename) &&
      !SOURCE_SLICES.some(slice => filename === slice || filename.startsWith(`${slice}/`)),
    );
    expect(unstaged.sort()).toEqual([]);
  });

  it("stages the neutral provider closure without deleted ZSR qualification sources", async () => {
    expect(SOURCE_SLICES).not.toContain("scripts/zsr-qualification");
    // Cloud agent context names this skill; the engine finds it under worker/.
    expect(SOURCE_SLICES).toContain("apps/desktop/resources/zeros-design-skill");
    // This fixed executable is selected by path, not an import edge. Its
    // source must travel with the original owner for runner.v1 ingress.
    const frontend = "apps/desktop/src/engine/cloud-interactive-frontend.mjs";
    expect(SOURCE_SLICES.some(slice => frontend.startsWith(`${slice}/`))).toBe(true);
    expect((await readFile(frontend, "utf8")).length).toBeGreaterThan(0);
    const probe = await readFile("scripts/cloud-workspace-validation/runtime-bundle/probe.cjs", "utf8");
    expect(probe).not.toContain("@anthropic-ai/sandbox-runtime");
    expect(probe).not.toContain("zsr-supervisor.mjs");
    expect(probe).not.toContain("containment/zsr-boundary.ts");
    expect(probe).toContain("host-process-supervisor.mjs");
  });
  it("retains production, peer, optional and workspace edges, terminates cycles, and regenerates relocatable shims", async () => {
    const temp = await directory(),
      source = path.join(temp, "source"),
      runtime = path.join(temp, "runtime");
    const a = path.join(source, "node_modules/.pnpm/a@1/node_modules/a");
    const b = path.join(source, "node_modules/.pnpm/b@1/node_modules/b");
    const peer = path.join(
      source,
      "node_modules/.pnpm/peer@1/node_modules/peer",
    );
    const workspace = path.join(source, "packages/library");
    await json(path.join(source, "package.json"), {
      dependencies: { a: "1", library: "workspace:*" },
      devDependencies: { unused: "1" },
    });
    await json(path.join(a, "package.json"), {
      name: "a",
      version: "1.0.0",
      dependencies: { b: "1" },
      peerDependencies: { peer: "1" },
      bin: { cli: "cli.js" },
    });
    await writeFile(
      path.join(a, "cli.js"),
      "#!/usr/bin/env node\nconsole.log('ok');\n",
    );
    await json(path.join(b, "package.json"), {
      name: "b",
      version: "1.0.0",
      dependencies: { a: "1" },
      optionalDependencies: { missing: "1" },
    });
    await json(path.join(peer, "package.json"), {
      name: "peer",
      version: "1.0.0",
    });
    await json(path.join(workspace, "package.json"), {
      name: "library",
      version: "1.0.0",
      dependencies: { b: "1" },
    });
    await link(a, path.join(source, "node_modules/a"));
    await link(workspace, path.join(source, "node_modules/library"));
    await link(b, path.join(path.dirname(a), "b"));
    await link(peer, path.join(path.dirname(a), "peer"));
    await link(a, path.join(path.dirname(b), "a"));
    await link(b, path.join(workspace, "node_modules/b"));
    await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
    await writeFile(
      path.join(source, "node_modules/.bin/cli"),
      `original absolute shim: ${source}`,
    );
    const packages = await stageDependencyClosure(source, runtime, {
      harnessRoots: [],
    });
    expect(packages.map((pkg) => pkg.name).sort()).toEqual([
      "a",
      "b",
      "library",
      "peer",
    ]);
    const worker = path.join(runtime, "worker");
    expect(await readlink(path.join(worker, "node_modules/a"))).toBe(
      ".pnpm/a@1/node_modules/a",
    );
    expect(await readlink(path.join(worker, "node_modules/library"))).toBe(
      "../packages/library",
    );
    expect(
      (
        await lstat(
          path.join(worker, "node_modules/.pnpm/a@1/node_modules/a/cli.js"),
        )
      ).nlink,
    ).toBe(1);
    const shim = await readFile(
      path.join(worker, "node_modules/.bin/cli"),
      "utf8",
    );
    expect(shim).not.toContain(source);
    expect(shim).not.toContain("NODE_PATH");
    expect(shim).toContain("../../../bin/node");
    await mkdir(path.join(runtime, "bin"));
    await writeFile(
      path.join(runtime, "bin/node"),
      '#!/bin/sh\nprintf "%s\\n" "$1"\n',
      { mode: 0o555 },
    );
    await rm(source, { recursive: true });
    const relocated = path.join(temp, "relocated");
    await rename(runtime, relocated);
    const target = execFileSync(
      path.join(relocated, "worker/node_modules/.bin/cli"),
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
    ).trim();
    expect(path.resolve(target)).toBe(
      path.join(
        relocated,
        "worker/node_modules/.pnpm/a@1/node_modules/a/cli.js",
      ),
    );
    await expect(inventoryTree(relocated)).resolves.toBeTruthy();
  });

  it("omits musl optional payload, links and shims while the relocated glibc agent still runs", async () => {
    const temp = await directory(), source = path.join(temp, "source"), runtime = path.join(temp, "runtime");
    const agent = path.join(source, "node_modules/.pnpm/agent@1/node_modules/agent");
    const glibc = path.join(source, "node_modules/.pnpm/native-glibc@1/node_modules/native-glibc");
    const musl = path.join(source, "node_modules/.pnpm/native-musl@1/node_modules/native-musl");
    const muslOnly = path.join(source, "node_modules/.pnpm/musl-only@1/node_modules/musl-only");
    await json(path.join(source, "package.json"), { dependencies: { agent: "1" } });
    await json(path.join(agent, "package.json"), { name: "agent", version: "1", main: "index.cjs",
      optionalDependencies: { "native-glibc": "1", "native-musl": "1" } });
    await writeFile(path.join(agent, "index.cjs"), 'module.exports = require("native-glibc");\n');
    for (const [name, physical, libc] of [["native-glibc", glibc, "glibc"], ["native-musl", musl, "musl"]]) {
      await json(path.join(physical, "package.json"), { name, version: "1", main: "index.cjs",
        os: ["linux"], cpu: ["x64"], libc: [libc], bin: { [name]: "cli" },
        ...(libc === "musl" ? { dependencies: { "musl-only": "1" } } : {}) });
      await writeFile(path.join(physical, "cli"), `#!/bin/sh\nprintf '%s' '${libc}-fixture'\n`, { mode: 0o555 });
      await writeFile(path.join(physical, "index.cjs"),
        'module.exports = () => require("node:child_process").execFileSync(require("node:path").join(__dirname, "cli"), {encoding:"utf8"});\n');
      await writeFile(path.join(physical, "LICENSE"), "fixture notice\n");
      await link(physical, path.join(path.dirname(agent), name));
    }
    await json(path.join(muslOnly, "package.json"), { name: "musl-only", version: "1" });
    await link(muslOnly, path.join(path.dirname(musl), "musl-only"));
    await link(agent, path.join(source, "node_modules/agent"));
    const before = await readFile(path.join(musl, "package.json"));

    const packages = await stageDependencyClosure(source, runtime, { harnessRoots: [] });
    expect(packages.map(pkg => pkg.name).sort()).toEqual(["agent", "native-glibc"]);
    const entries = await inventoryTree(runtime);
    expect(entries.some(entry => entry.path.includes("musl"))).toBe(false);
    expect(await readFile(path.join(musl, "package.json"))).toEqual(before);
    expect(await readFile(path.join(musl, "cli"), "utf8")).toContain("musl-fixture");
    await rm(source, { recursive: true });
    const relocated = path.join(temp, "relocated");
    await rename(runtime, relocated);
    const worker = path.join(relocated, "worker");
    expect(execFileSync(process.execPath,
      ["-e", "process.stdout.write(require(process.argv[1])())", path.join(worker, "node_modules/agent")],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } })).toBe("glibc-fixture");
    const stagedAgent = packages.find(pkg => pkg.name === "agent")!;
    expect(execFileSync(path.join(relocated, stagedAgent.path, "node_modules/.bin/native-glibc"),
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } })).toBe("glibc-fixture");
    await expect(lstat(path.join(relocated, stagedAgent.path, "node_modules/.bin/native-musl")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const stagedGlibc = packages.find(pkg => pkg.name === "native-glibc")!;
    expect(await readFile(path.join(relocated, stagedGlibc.path, "LICENSE"), "utf8")).toBe("fixture notice\n");
  });

  it.each([
    { libc: undefined, retained: true },
    { libc: ["glibc"], retained: true },
    { libc: ["glibc", "musl"], retained: true },
    { libc: ["!musl"], retained: true },
    { libc: ["glibc", "!musl"], retained: true },
    { libc: ["musl"], retained: false },
    { libc: ["!glibc"], retained: false },
    { libc: ["glibc", "!glibc"], retained: false },
  ])("uses declared libc metadata for optional packages: $libc => $retained", async ({ libc, retained }) => {
    const temp = await directory(), source = path.join(temp, "source"), runtime = path.join(temp, "runtime");
    await json(path.join(source, "package.json"), { optionalDependencies: { optional: "1" } });
    await json(path.join(source, "node_modules/optional/package.json"),
      { name: "optional", version: "1", os: ["linux"], cpu: ["x64"], ...(libc ? { libc } : {}) });
    const packages = await stageDependencyClosure(source, runtime, { harnessRoots: [] });
    expect(packages.map(pkg => pkg.name)).toEqual(retained ? ["optional"] : []);
    expect((await inventoryTree(runtime)).some(entry => entry.path.includes("node_modules/optional"))).toBe(retained);
  });

  it.each(["dependencies", "peerDependencies"])("refuses incompatible required libc edges in %s", async edge => {
    const temp = await directory(), source = path.join(temp, "source");
    await json(path.join(source, "package.json"), { dependencies: { agent: "1" } });
    await json(path.join(source, "node_modules/agent/package.json"),
      { name: "agent", version: "1", [edge]: { incompatible: "1" } });
    await json(path.join(source, "node_modules/incompatible/package.json"),
      { name: "incompatible", version: "1", os: ["linux"], cpu: ["x64"], libc: ["musl"] });
    await expect(stageDependencyClosure(source, path.join(temp, "runtime"), { harnessRoots: [] }))
      .rejects.toThrow(/native_platform/);
  });

  it("omits incompatible optional peers but still refuses a later required edge to that package", async () => {
    const temp = await directory(), source = path.join(temp, "source");
    const optionalAgent = path.join(source, "node_modules/optional-agent");
    await json(path.join(source, "package.json"), { dependencies: { "optional-agent": "1" } });
    await json(path.join(optionalAgent, "package.json"), { name: "optional-agent", version: "1",
      peerDependencies: { incompatible: "1" }, peerDependenciesMeta: { incompatible: { optional: true } } });
    await json(path.join(source, "node_modules/incompatible/package.json"),
      { name: "incompatible", version: "1", libc: ["!glibc"] });
    expect((await stageDependencyClosure(source, path.join(temp, "optional"), { harnessRoots: [] }))
      .map(pkg => pkg.name)).toEqual(["optional-agent"]);
    await json(path.join(source, "package.json"), { dependencies: { "optional-agent": "1", "required-agent": "1" } });
    await json(path.join(source, "node_modules/required-agent/package.json"),
      { name: "required-agent", version: "1", dependencies: { incompatible: "1" } });
    await expect(stageDependencyClosure(source, path.join(temp, "required"), { harnessRoots: [] }))
      .rejects.toThrow(/native_platform/);
  });

  it("fails on missing required dependencies and external package targets", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { missing: "1" },
    });
    await expect(
      stageDependencyClosure(source, path.join(temp, "one"), {
        harnessRoots: [],
      }),
    ).rejects.toThrow(/dependency_missing/);
    await json(path.join(temp, "external/package.json"), {
      name: "missing",
      version: "1.0.0",
    });
    await link(
      path.join(temp, "external"),
      path.join(source, "node_modules/missing"),
    );
    await expect(
      stageDependencyClosure(source, path.join(temp, "two"), {
        harnessRoots: [],
      }),
    ).rejects.toThrow(/dependency_external/);
  });

  it("rejects a package bin symlink before chmod can follow it outside R", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), { dependencies: { a: "1" } });
    const pkg = path.join(source, "node_modules/a");
    await json(path.join(pkg, "package.json"), {
      name: "a",
      version: "1.0.0",
      bin: { a: "cli.js" },
    });
    const outside = path.join(temp, "external.js");
    await writeFile(outside, "#!/usr/bin/env node\n", { mode: 0o444 });
    await symlink(outside, path.join(pkg, "cli.js"));
    await expect(
      stageDependencyClosure(source, path.join(temp, "runtime"), {
        harnessRoots: [],
      }),
    ).rejects.toThrow(/symlink_escape/);
    expect((await lstat(outside)).mode & 0o777).toBe(0o444);
  });

  it("retains declared npm dependencies whose names also name Node built-ins", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { buffer: "1" },
    });
    await json(path.join(source, "node_modules/buffer/package.json"), {
      name: "buffer",
      version: "1.0.0",
    });
    const packages = await stageDependencyClosure(
      source,
      path.join(temp, "runtime"),
      { harnessRoots: [] },
    );
    expect(packages.map((entry) => entry.name)).toEqual(["buffer"]);
  });

  it("keeps rebuilt PTY and vendor notices without non-Linux PTY/SSH helpers", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { "node-pty": "1.1.0", ssh2: "1.17.0" },
    });
    const pkg = path.join(source, "node_modules/node-pty");
    await json(path.join(pkg, "package.json"), {
      name: "node-pty",
      version: "1.1.0",
    });
    for (const name of [
      "build/Release/pty.node",
      "prebuilds/win32-x64/pty.node",
      "third_party/conpty/LICENSE",
      "third_party/conpty/win10-arm64/OpenConsole.exe",
      "third_party/conpty/win10-x64/conpty.dll",
    ]) {
      await mkdir(path.dirname(path.join(pkg, name)), { recursive: true });
      await writeFile(path.join(pkg, name), "fixture");
    }
    const ssh = path.join(source, "node_modules/ssh2");
    await json(path.join(ssh, "package.json"), {
      name: "ssh2",
      version: "1.17.0",
    });
    await mkdir(path.join(ssh, "util"));
    await writeFile(path.join(ssh, "util/pagent.exe"), "fixture");
    await writeFile(path.join(ssh, "LICENSE"), "fixture license");
    const runtime = path.join(temp, "runtime");
    await stageDependencyClosure(source, runtime, { harnessRoots: [] });
    const entries = (await inventoryTree(runtime)).map((entry) => entry.path);
    expect(entries).toContain(
      "worker/node_modules/node-pty/build/Release/pty.node",
    );
    expect(entries).toContain(
      "worker/node_modules/node-pty/third_party/conpty/LICENSE",
    );
    expect(entries).toContain("worker/node_modules/ssh2/LICENSE");
    expect(
      entries.some(
        (name) => /\.(exe|dll)$/.test(name) || name.includes("prebuilds/"),
      ),
    ).toBe(false);
  });

  it("omits upstream credential examples and test keys while retaining notices", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { "@octokit/auth-token": "6", ssh2: "1", zod: "4" },
    });
    const example = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(
      "",
    );
    for (const [name, relative] of [
      ["@octokit/auth-token", "README.md"],
      ["ssh2", "test/fixtures/key"],
      ["zod", "src/v4/mini/tests/string.test.ts"],
    ]) {
      const pkg = path.join(source, "node_modules", name);
      await json(path.join(pkg, "package.json"), {
        name,
        version: "1.0.0",
        license: "MIT",
      });
      await mkdir(path.dirname(path.join(pkg, relative)), { recursive: true });
      await writeFile(path.join(pkg, relative), example);
      await writeFile(path.join(pkg, "LICENSE"), "Unmodified upstream license");
    }
    const runtime = path.join(temp, "runtime");
    await stageDependencyClosure(source, runtime, { harnessRoots: [] });
    await expect(scanPayload(runtime, [])).resolves.toBeUndefined();
    const entries = await inventoryTree(runtime);
    expect(
      entries.filter((entry) => entry.path.endsWith("/LICENSE")),
    ).toHaveLength(3);
  });

  it("rejects installed packages for another CPU or OS", async () => {
    const temp = await directory(),
      source = path.join(temp, "source");
    await json(path.join(source, "package.json"), {
      dependencies: { wrong: "1" },
    });
    await json(path.join(source, "node_modules/wrong/package.json"), {
      name: "wrong",
      version: "1.0.0",
      os: ["darwin"],
      cpu: ["arm64"],
    });
    await expect(
      stageDependencyClosure(source, path.join(temp, "runtime"), {
        harnessRoots: [],
      }),
    ).rejects.toThrow(/native_platform/);
  });

  it("matches the legacy helpers plus the v4 update adapter, resident host and optional self-test", async () => {
    const legacy = await readFile(
      "scripts/cloud-workspace-validation/boat-image/templates/build.sh",
      "utf8",
    );
    const names = /for name in (.*); do/.exec(legacy)![1].split(" ");
    expect(
      RUNTIME_HELPERS.filter(
        (entry) =>
          !entry.optional && entry.target.endsWith(".apparmor") === false,
      )
        .map((entry) => path.basename(entry.target))
        .sort(),
    ).toEqual([...names, "runtime-update-adapter.py", "cloud-resident-workload.mjs",
      "prepare-cloud-image-files.mjs", "prepare-cloud-git.mjs", "publish-cloud-workload-custody.mjs", "cloud-resource-budget.mjs",
      "cloud-resident-control.mjs"].sort());
    expect(RUNTIME_HELPERS).toContainEqual({
      source: "scripts/cloud-workspace-validation/sandbox/cloud-resource-budget.mjs",
      target: "lib/zeros/cloud-resource-budget.mjs", optional: false,
    });
    expect(RUNTIME_HELPERS).toContainEqual({
      source:
        "apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs",
      target: "lib/zeros/cloud-runtime-root.mjs",
      optional: false,
    });
    expect(
      RUNTIME_HELPERS.some(
        (entry) =>
          entry.optional && entry.target === "lib/zeros/runtime-self-test.mjs",
      ),
    ).toBe(true);
  });

  it("stages the runtime-root resolver and performance import without depending on the source checkout", async () => {
    const temp = await directory(),
      source = path.join(temp, "source"),
      runtime = path.join(temp, "runtime");
    const resolverSource =
      "apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
    const contents = await readFile(resolverSource);
    const performanceSource = "scripts/cloud-workspace-validation/sandbox/cloud-setup-performance.mjs";
    const performanceContents = await readFile(performanceSource);
    for (const relative of SOURCE_SLICES)
      await mkdir(path.join(source, relative), { recursive: true });
    for (const relative of [
      ...ROOT_METADATA,
      ...SOURCE_FILES,
      ...RUNTIME_HELPERS.filter((entry) => !entry.optional).map(
        (entry) => entry.source,
      ),
      ...hostSources,
      "scripts/cloud-workspace-validation/sandbox/start-engine.sh",
    ]) {
      const filename = path.join(source, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, "fixture");
    }
    await mkdir(path.dirname(path.join(source, resolverSource)), {
      recursive: true,
    });
    await writeFile(path.join(source, resolverSource), contents);
    await writeFile(path.join(source, performanceSource), performanceContents);
    const assetSource = "apps/desktop/src/engine/agents/containment/cloud-runtime-assets.mjs";
    await writeFile(path.join(source, assetSource), await readFile(assetSource));
    await link(
      path.join(source, resolverSource),
      path.join(
        source,
        "scripts/cloud-workspace-validation/sandbox/cloud-runtime-root.mjs",
      ),
    );
    await stageSources(source, runtime);
    const resolver = path.join(runtime, "lib/zeros/cloud-runtime-root.mjs");
    const performance = path.join(runtime, "lib/zeros/cloud-setup-performance.mjs");
    expect(await readFile(resolver)).toEqual(contents);
    expect((await lstat(resolver)).nlink).toBe(1);
    const performanceFile = await open(performance, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      expect((await performanceFile.stat()).isFile()).toBe(true);
      expect(await performanceFile.readFile()).toEqual(performanceContents);
    } finally { await performanceFile.close(); }
    for (const relative of hostSources) {
      const staged = path.join(runtime, "worker", relative);
      const file = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        expect((await file.stat()).isFile()).toBe(true);
        expect(await file.readFile()).toEqual(await readFile(path.join(source, relative)));
      } finally { await file.close(); }
    }
    expect(await inventoryTree(runtime)).toContainEqual(
      expect.objectContaining({
        path: "lib/zeros/cloud-runtime-root.mjs",
        type: "file",
        mode: "0555",
        size: contents.length,
      }),
    );
    await rm(path.join(source, performanceSource));
    await expect(stageSources(source, path.join(temp, "missing-performance"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(source, performanceSource), performanceContents);
    await rm(path.join(source, resolverSource));
    await expect(
      stageSources(source, path.join(temp, "missing-resolver")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await rm(source, { recursive: true });
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          'import { pathToFileURL } from "node:url"; const resolver = await import(pathToFileURL(process.argv[1]).href); const timers = await import(pathToFileURL(process.argv[2]).href); process.stdout.write(String(resolver.cloudProfileIdentityMapVersion(4)) + ":" + typeof timers.setupPerformance);',
          resolver,
          performance,
        ],
        { cwd: runtime, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
      ),
    ).toBe("5:function");
  });

  it("loads the actual staged engine capability and its public channel-policy imports outside src", async () => {
    const temp = await directory(), source = path.join(temp, "source"), runtime = path.join(temp, "runtime");
    const imports = [
      "apps/desktop/src/engine/cloud-workspace-capability.ts",
      "apps/desktop/src/engine/runtime.ts",
      "apps/desktop/shared/cloud-workspace-channel.ts",
      "apps/control-plane/src/cloud-workspace-channels.json",
    ];
    for (const slice of SOURCE_SLICES) await mkdir(path.join(source, slice), { recursive: true });
    for (const relative of new Set([...ROOT_METADATA, ...SOURCE_FILES, ...RUNTIME_HELPERS.filter(helper => !helper.optional).map(helper => helper.source),
      ...hostSources, ...imports, "scripts/cloud-workspace-validation/sandbox/start-engine.sh"])) {
      const filename = path.join(source, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, imports.includes(relative) ? await readFile(relative) : "fixture");
    }
    await writeFile(path.join(source, "package.json"), "{}");
    await stageSources(source, runtime);
    const require = createRequire(import.meta.url);
    const entry = path.join(runtime, "worker", imports[0]);
    const observed = execFileSync(process.execPath, ["--require", require.resolve("tsx/cjs"), "--eval",
      `try { const m=require(${JSON.stringify(entry)}); const result=m.createCloudWorkspaceDesktopPipelines({cloudWorker:true, ` +
      "capabilityEnabled(){throw new Error('VM must not evaluate desktop capability');}}); " +
      "process.stdout.write(JSON.stringify({loaded:true,result})); } catch(error) { " +
      "process.stdout.write(JSON.stringify({loaded:false,code:error.code})); }"], {
      cwd: temp, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(observed)).toEqual({ loaded: true, result: { replica: null, fork: null } });
    for (const relative of imports.slice(2)) {
      const staged = path.join(runtime, "worker", relative);
      expect(await readFile(staged)).toEqual(await readFile(relative));
      expect((await lstat(staged)).isFile()).toBe(true);
      await rm(path.join(source, relative));
      await expect(stageSources(source, path.join(temp, path.basename(relative)))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path.join(source, relative), await readFile(relative));
    }
  });

  it.each(hostSources.flatMap(relative => [
    { relative, kind: "missing" }, { relative, kind: "aliased" },
  ]))("refuses $kind required Host source $relative before staging", async ({ relative, kind }) => {
    const temp = await directory(), source = path.join(temp, "source");
    for (const slice of SOURCE_SLICES) await mkdir(path.join(source, slice), { recursive: true });
    for (const filename of [...ROOT_METADATA, ...SOURCE_FILES, ...RUNTIME_HELPERS.map(helper => helper.source),
      ...hostSources, "scripts/cloud-workspace-validation/sandbox/start-engine.sh"]) {
      await mkdir(path.dirname(path.join(source, filename)), { recursive: true });
      await writeFile(path.join(source, filename), "fixture");
    }
    await rm(path.join(source, relative));
    if (kind === "aliased") {
      const alias = path.join(source, `${relative}.alias`);
      await writeFile(alias, "fixture");
      await link(alias, path.join(source, relative));
    }
    await expect(stageSources(source, path.join(temp, kind))).rejects.toThrow();
  });

  it("imports the actual resource-budget helper from its copied lib/zeros deployment path", async () => {
    const temp = await directory(), source = path.join(temp, "source"), runtime = path.join(temp, "runtime");
    for (const slice of SOURCE_SLICES) await mkdir(path.join(source, slice), { recursive: true });
    const actualHelpers = new Set(["cloud-resource-budget.mjs", "cloud-resource-admission.mjs", "cgroup-resources.mjs", "cloud-runtime-root.mjs", "cloud-runtime-assets.mjs"]);
    for (const relative of [...ROOT_METADATA, ...SOURCE_FILES, ...RUNTIME_HELPERS.map(helper => helper.source),
      ...hostSources, "scripts/cloud-workspace-validation/sandbox/start-engine.sh"]) {
      const filename = path.join(source, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, actualHelpers.has(path.basename(relative)) ? await readFile(relative) : "fixture");
    }
    await stageSources(source, runtime);
    const observed = execFileSync(process.execPath, ["--input-type=module", "--eval",
      "try { const m=await import('./lib/zeros/cloud-resource-budget.mjs'); " +
      "if(typeof m.parseCloudResourceBudgetProjection==='function'&&typeof m.readCloudResourceBudgetProjection==='function')process.stdout.write('imported'); } " +
      "catch { process.stdout.write('refused'); }"], {
      cwd: runtime, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(observed).toBe("imported");
  });

  it("stages the required resident-control helper with its actual import closure and refuses a missing source", async () => {
    const temp = await directory(), source = path.join(temp, "source"), runtime = path.join(temp, "runtime");
    const residentSource = "scripts/cloud-workspace-validation/sandbox/cloud-resident-control.mjs";
    for (const slice of SOURCE_SLICES) await mkdir(path.join(source, slice), { recursive: true });
    for (const relative of new Set([...ROOT_METADATA, ...SOURCE_FILES, ...RUNTIME_HELPERS.filter(helper => !helper.optional).map(helper => helper.source),
      ...hostSources, residentSource, "scripts/cloud-workspace-validation/sandbox/start-engine.sh"])) {
      const filename = path.join(source, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, await readFile(relative));
    }
    await stageSources(source, runtime);
    const staged = path.join(runtime, "lib/zeros/cloud-resident-control.mjs");
    expect(await readFile(staged)).toEqual(await readFile(residentSource));
    expect(await lstat(staged)).toMatchObject({ nlink: 1 });
    expect((await lstat(staged)).mode & 0o777).toBe(0o555);
    execFileSync(process.execPath, ["--check", staged], { stdio: ["ignore", "pipe", "pipe"] });
    const observed = execFileSync(process.execPath, ["--input-type=module", "--eval",
      "const m=await import('./lib/zeros/cloud-resident-control.mjs'); process.stdout.write(typeof m.CloudLegacyResidentControl);"], {
      cwd: runtime, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(observed).toBe("function");
    await rm(path.join(source, residentSource));
    await expect(stageSources(source, path.join(temp, "missing-resident-control"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("payload hygiene", () => {
  const runnerPaths = {
    sourceDir: "/home/runner/work/zeros/zeros",
    outDir: "/home/runner/work/_temp/cloud-runtime-bundle",
    work: "/home/runner/work/_temp/zeros-runtime-build-fixture",
  };
  it("scans the actual runner build roots without rejecting upstream SDK build provenance", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/runner");
    const root = await directory();
    // SDK executables ship upstream compiler paths in live ELF sections.
    // Those bytes also appear in successful bundles built outside CI.
    await writeFile(
      path.join(root, "vendor-native"),
      Buffer.from("\0/home/runner/work/vendor/sdk/source.rs\0"),
    );
    await expect(
      scanPayload(root, buildPathPrefixes(runnerPaths)),
    ).resolves.toBeUndefined();
  });
  it.each(["sourceDir", "outDir", "work", "privateHome"] as const)(
    "still rejects the runner's %s across chunk boundaries",
    async (name) => {
      vi.spyOn(os, "homedir").mockReturnValue("/home/runner");
      const root = await directory();
      const hostPath =
        name === "privateHome"
          ? buildEnvironment(runnerPaths.work).HOME!
          : runnerPaths[name];
      await writeFile(
        path.join(root, "native-build-output"),
        Buffer.concat([Buffer.alloc(65530), Buffer.from(`${hostPath}/input`)]),
      );
      await expect(
        scanPayload(root, buildPathPrefixes(runnerPaths)),
      ).rejects.toThrow(/^build_path$/);
    },
  );
  it.each(["file", "symlink"] as const)(
    "reports only the offending relative %s path on stderr and keeps stdout closed",
    async (kind) => {
      const root = await directory();
      await mkdir(path.join(root, "worker"));
      const entry = `worker/${kind}`;
      const hostPath = `${runnerPaths.work}/private-build-input`;
      if (kind === "symlink") await symlink(hostPath, path.join(root, entry));
      else await writeFile(path.join(root, entry), hostPath);
      const error = await scanPayload(
        root,
        buildPathPrefixes(runnerPaths),
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      diagnostic("scan_payload", error);
      expect(stderr.mock.calls).toEqual([
        [JSON.stringify({ stage: "scan_payload", check: "build_path", entry })],
      ]);
      expect(stdout.mock.calls).toEqual([
        [
          JSON.stringify({
            schema: "zeros.diagnostic/v1",
            component: "bundle",
            stage: "scan_payload",
            ok: false,
            exitCode: null,
            timedOut: false,
            failedChecks: ["build_path"],
          }),
        ],
      ]);
    },
  );
  it("does not expose credential-shaped filenames in scan diagnostics", async () => {
    const root = await directory();
    const entry = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
    await writeFile(path.join(root, entry), runnerPaths.work);
    const error = await scanPayload(root, buildPathPrefixes(runnerPaths)).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    diagnostic("scan_payload", error);
    expect(stderr).not.toHaveBeenCalled();
  });
  it("rejects host paths even across scan chunks, without exposing contents", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, "binary"),
      Buffer.concat([
        Buffer.alloc(65530),
        Buffer.from("/private/build-path/hidden"),
      ]),
    );
    await expect(scanPayload(root, ["/private/build-path"])).rejects.toThrow(
      /^build_path$/,
    );
  });
  it("rejects token-shaped data and forbidden names without printing the match", async () => {
    const root = await directory();
    const body = "abcdefghijklmnopqrstuvwxyz0123456789";
    await writeFile(path.join(root, "token"), ["gh", "p_", body].join(""));
    await expect(scanPayload(root, [])).rejects.toThrow(/^secret_shape$/);
    await rm(path.join(root, "token"));
    await writeFile(path.join(root, ".env.example"), "placeholder");
    await expect(scanPayload(root, [])).rejects.toThrow(/^forbidden_payload$/);
  });
  it("allows credential pattern definitions, digests and low-entropy test placeholders", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, "patterns"),
      ["gh[pous]_[A-Za-z0-9]{36}", "a".repeat(64), "sk-" + "x".repeat(48)].join(
        "\n",
      ),
    );
    await chmod(path.join(root, "patterns"), 0o444);
    await expect(scanPayload(root, [])).resolves.toBeUndefined();
  });
  it("does not mistake compiled format strings or adjacent provider prefixes for tokens", async () => {
    const root = await directory();
    const symbols = [
      "gh",
      "p_",
      "a_format_string_with_underscores_and_no_credential",
    ].join("");
    const prefixes = [
      "sk-",
      "proj-",
      "sk-",
      "svcacct-",
      "sk-",
      "OPENAI_API_KEY",
      "field",
    ].join("");
    await writeFile(
      path.join(root, "binary"),
      Buffer.from(`\0${symbols}\0${prefixes}\0`),
    );
    await expect(scanPayload(root, [])).resolves.toBeUndefined();
  });
});

// Opt-in real-build acceptance. The normal unit suite never downloads or builds.
// Run with ZEROS_RUNTIME_BUNDLE_TEST_DIR=<outDir> after the builder succeeds.
describe.skipIf(!process.env.ZEROS_RUNTIME_BUNDLE_TEST_DIR)(
  "extracted Linux archive closure",
  () => {
    it("resolves v4 runtime paths using the isolated probe fixture", async () => {
      const { runClosureProbes } =
        await import("../cloud-workspace-validation/runtime-bundle/probe");
      const toolchain =
        await import("../cloud-workspace-validation/runtime-bundle/toolchain");
      const temp = await directory(),
        runtime = path.join(temp, "runtime");
      // Resolver-only fixture; the full archive test below checks pinned ABI.
      for (const name of [
        "bin/node",
        "bin/start-engine.sh",
        "bin/cloud-engine-namespace",
        ...hostSources.map(relative => `worker/${relative}`),
        "lib/zeros/setup-cloud-workspace.mjs",
        "lib/zeros/cloud-worker-supervisor.mjs",
        "worker/dist-engine/cli.js",
      ]) {
        await mkdir(path.dirname(path.join(runtime, name)), {
          recursive: true,
        });
        await writeFile(path.join(runtime, name), "", { mode: 0o555 });
      }
      await chmod(path.join(runtime, "bin/node"), 0o755);
      await copyFile(process.execPath, path.join(runtime, "bin/node"));
      await chmod(path.join(runtime, "bin/node"), 0o555);
      await chmod(path.join(runtime, "bin/cloud-engine-namespace"), 0o500);
      await copyFile(
        "apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs",
        path.join(runtime, "lib/zeros/cloud-runtime-root.mjs"),
      );
      await chmod(
        path.join(runtime, "lib/zeros/cloud-runtime-root.mjs"),
        0o555,
      );
      await writeFile(
        path.join(runtime, "manifest.json"),
        canonicalJson(
          createManifest(
            {
              source: {
                commit: "a".repeat(40),
                lockfileSha256: "b".repeat(64),
              },
              engineProtocolVersion: 20,
              agents: {
                claude: { sdk: "1", cli: "1" },
                codex: { package: "1" },
                cursor: { sdk: "1" },
              },
            },
            await inventoryTree(runtime),
          ),
        ),
        { mode: 0o444 },
      );
      const probe = path.join(temp, "resolver-probe.cjs");
      await writeFile(
        probe,
        `
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const root = process.argv[2];
(async () => {
  const { resolveCloudRuntime } = await import(pathToFileURL(root + "/lib/zeros/cloud-runtime-root.mjs").href);
  const runtime = resolveCloudRuntime();
  assert.equal(runtime.profile, "v4");
  assert.equal(runtime.root, root);
  assert.equal(runtime.node, process.execPath);
  assert.equal(runtime.helpers.setup, root + "/lib/zeros/setup-cloud-workspace.mjs");
  console.log(JSON.stringify({ checks: ["runtime_root"] }));
  console.log(JSON.stringify({ component: "bundle", ok: true, failedChecks: [] }));
})().catch(() => { process.exitCode = 1; });
`,
      );
      const runTool = toolchain.runTool;
      const spy = vi
        .spyOn(toolchain, "runTool")
        .mockImplementation((command, args, options, failure) => {
          // This fixture proves the runtime-root resolver. The normal payload
          // regression and real archive case execute Cursor as the engine.
          if (args.at(-1) === "cursor") return Promise.resolve(
            `${JSON.stringify({ checks: ["cursor_load"] })}\n${JSON.stringify({ component: "bundle", ok: true, failedChecks: [] })}`,
          );
          const replaced = [...args];
          const mount = replaced.indexOf("/probe.cjs");
          expect(replaced[mount - 2]).toBe("--ro-bind");
          replaced[mount - 1] = probe;
          return runTool(command, replaced, options, failure);
        });
      try {
        await expect(runClosureProbes(runtime)).resolves.toMatchObject({
          checks: ["runtime_root", "cursor_load"],
          isolation: "mount_namespace_no_network",
        });
      } finally {
        spy.mockRestore();
      }
    }, 30_000);

    it("checks the descriptor, every file hash and offline probes with no checkout or store", async () => {
      const { verifyBundleDirectory } =
        await import("../cloud-workspace-validation/runtime-bundle/verify");
      const directory = path.resolve(
        process.env.ZEROS_RUNTIME_BUNDLE_TEST_DIR!,
      );
      const result = await verifyBundleDirectory(directory, true);
      const receipt = JSON.parse(
        await readFile(path.join(directory, "build-receipt.json"), "utf8"),
      );
      expect(receipt.fileCount).toBe(
        result.manifest.files.filter((entry) => entry.type === "file").length,
      );
      expect(receipt.entryCount).toBe(result.manifest.files.length);
      expect(receipt.fileCount).toBeLessThan(receipt.entryCount);
      expect(result.manifest.files).toContainEqual(
        expect.objectContaining({
          path: "lib/zeros/cloud-runtime-root.mjs",
          type: "file",
          mode: "0555",
        }),
      );
      expect(result.closure?.checks).toContain("engine_help");
      expect(result.closure?.checks).toContain("sqlite_query");
      expect(result.closure?.checks).toContain("pty_load");
      expect(result.closure?.checks).toContain("claude_version");
      expect(result.closure?.checks).toContain("codex_version");
      expect(result.closure?.checks).toContain("cursor_load");
    }, 300_000);
  },
);
