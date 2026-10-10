import * as fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";

const helperDirectory = path.resolve("scripts/cloud-workspace-validation/sandbox");
const require = createRequire(path.join(helperDirectory, "cloud-setup-process.mjs"));
const sources = new Map<string, string>();
const trees: ReturnType<typeof cloudRuntimeFixture>[] = [];
afterEach(() => { for (const tree of trees.splice(0)) tree.dispose(); });

// Execute the original CLI and admission code against a logical VM filesystem.
// Only process launch, stdin and the filesystem root are substituted; the
// runtime resolver and all computer-admission checks run unchanged.
async function loadHelper(name: string, imports: Record<string, unknown>, process: unknown) {
  const file = path.join(helperDirectory, name);
  let source = sources.get(name);
  if (!source) {
    source = ts.transpileModule(fs.readFileSync(file, "utf8")
      .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(file).href)), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    sources.set(name, source);
  }
  const exports: Record<string, any> = {};
  await runInNewContext(`(async () => {${source}})()`, {
    exports, module: { exports }, process, Buffer,
    require: (name: string) => name in imports ? imports[name] : require(name),
  });
  return exports;
}

async function fixture() {
  const tree = cloudRuntimeFixture();
  trees.push(tree);
  const resolver = createCloudRuntimeResolver({ filesystem: tree.filesystem,
    executable: () => `${tree.descriptor.root}/bin/node`, isEngine: () => false });
  const runtime = resolver.resolve();
  const resolvers = { resolveCloudRuntime: vi.fn(() => resolver.resolve()),
    resolveCloudRuntimeChild: vi.fn(() => resolver.resolveChild()) };
  const repositoryDirectory = "/srv/zeros/files/repos/fixture/primary";
  tree.mkdir(`${repositoryDirectory}/.git`);
  for (const file of [repositoryDirectory, `${repositoryDirectory}/.git`]) {
    tree.owners.set(file, 10003);
    fs.chmodSync(tree.physical(file), 0o700);
  }
  const template = { schema: "zeros.computer-template/v1",
    buildId: tree.descriptor.bootId, configId: tree.descriptor.supervisorSessionId,
    baseImageId: "zeros-v2-test-base", runtimeId: runtime.runtimeId,
    baseCompatibilityId: runtime.baseCompatibilityId, protectedContractDigest: "d".repeat(64),
    repositoryManifest: [{ id: "123", owner: "fixture", name: "primary", sha: "e".repeat(40) }] };
  tree.write("/srv/zeros/computer-template.json", template);
  tree.write("/proc/self/mountinfo", "");
  const filesystem = { ...fs, ...tree.filesystem,
    readFileSync: (file: string | number, options: any) =>
      fs.readFileSync(typeof file === "number" ? file : tree.physical(file), options),
    readdirSync: (file: string, options: any) => fs.readdirSync(tree.physical(file), options),
    existsSync: (file: string) => fs.existsSync(tree.physical(file)),
  };
  const computer = await loadHelper("cloud-computer-checkout.mjs", {
    "node:fs": filesystem, "./cloud-runtime-root.mjs": resolvers,
  }, { argv: [] });
  const admission = computer.createCloudComputerWorkspaceAdmission({
    computer: { template, primaryRepositoryId: "123", requestedRevision: "feature/workspace" },
    repository: { forge: "github.com", owner: "fixture", name: "primary",
      revision: template.repositoryManifest[0]!.sha, cloneUrl: "https://github.com/fixture/primary.git" },
    execution: { workspaceId: template.buildId, organizationId: template.configId,
      setupRunId: template.buildId, generation: 1, executionFence: 2 },
    engine: { instanceId: template.configId },
  }, runtime);
  tree.write("/run/zeros/computer-workspace.json", admission, 0o600);

  async function worker(command: string, privileged = true) {
    const payload = { version: 1, command, environment: {}, timeoutMs: 1000 };
    const input = Buffer.from(JSON.stringify(payload));
    let consumed = false;
    const spawn = vi.fn((_file: string, _args: string[], options: any) => {
      // The helper erases stdin after spawnSync returns; retain only test data.
      if (options.input) options.input = Buffer.from(options.input);
      return { status: 0, signal: null };
    });
    const fakeProcess = { argv: [runtime.node, path.join(helperDirectory, "cloud-setup-process.mjs"),
      privileged ? "--worker" : "--unprivileged"], platform: "linux", getuid: () => privileged ? 0 : 10003,
      cwd: () => repositoryDirectory, exitCode: 0, stderr: { write: vi.fn() } };
    await loadHelper("cloud-setup-process.mjs", {
      "node:fs": { ...filesystem, readSync: (fd: number, buffer: Buffer, offset: number) => {
        if (fd === 3) { buffer[offset] = 42; return 1; }
        if (fd !== 0) throw new Error("Unexpected worker descriptor");
        if (consumed) return 0;
        consumed = true;
        input.copy(buffer, offset);
        return input.length;
      } },
      "node:child_process": { spawnSync: spawn },
      "./cloud-runtime-root.mjs": resolvers,
      "./cloud-computer-checkout.mjs": computer,
      "./cloud-engine-cgroup.mjs": {},
    }, fakeProcess);
    return { spawn, process: fakeProcess, payload };
  }
  return { tree, runtime, resolver, resolvers, computer, admission, repositoryDirectory, worker };
}

describe("Cloud Computer setup worker admission", () => {
  it.each([
    ["attestation canary", "printf ready"],
    ["repository setup hook", "pwd; id -u"],
  ])("admits the %s with the full host identity before dropping privileges", async (_name, command) => {
    const f = await fixture();
    // This is the exact live failure: a pinned child knows its runtime ID but
    // cannot bind the root-private admission to a boot or supervisor session.
    expect(f.resolver.resolveChild()).toMatchObject({ runtimeId: f.runtime.runtimeId });
    expect(f.resolver.resolveChild()).not.toHaveProperty("bootId");
    expect(() => f.computer.cloudComputerHostRepository(f.resolver.resolveChild()))
      .toThrow("image_contract_invalid");
    const result = await f.worker(command);
    expect(result.process.exitCode).toBe(0);
    expect(result.process.stderr.write).not.toHaveBeenCalled();
    expect(result.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/setpriv", [
      "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
      "--pdeathsig=SIGKILL", "--reuid=10003", "--regid=10003", "--clear-groups",
      f.runtime.node, f.runtime.helpers.setupProcess, "--unprivileged",
    ], expect.objectContaining({ cwd: f.repositoryDirectory, timeout: 1000, killSignal: "SIGKILL" }));
    expect(JSON.parse(result.spawn.mock.calls[0]![2].input.toString())).toEqual(result.payload);
  });

  it.each(["runtimeId", "manifestSha256", "baseCompatibilityId", "bootId", "supervisorSessionId"])(
    "still refuses a computer admission with a mismatched %s before any process launch", async key => {
      const f = await fixture();
      f.admission.runtime[key] = key.endsWith("Id") && ["bootId", "supervisorSessionId"].includes(key)
        ? "33333333-3333-4333-8333-333333333333"
        : f.admission.runtime[key].replace(/[ab]/g, "f");
      f.tree.write("/run/zeros/computer-workspace.json", f.admission, 0o600);
      const result = await f.worker("printf ready");
      expect(result.process.exitCode).toBe(125);
      expect(result.spawn).not.toHaveBeenCalled();
    },
  );

  it("executes the hook after privilege drop without reading private host admission or runtime state", async () => {
    const f = await fixture();
    for (const file of ["/run/zeros/computer-workspace.json", "/run/zeros/active-runtime.json"])
      fs.rmSync(f.tree.physical(file));
    f.resolvers.resolveCloudRuntime.mockImplementation(() => { throw new Error("Root-only runtime unavailable"); });
    const result = await f.worker("pwd; id -u", false);
    expect(result.process.exitCode).toBe(0);
    expect(f.resolvers.resolveCloudRuntime).not.toHaveBeenCalled();
    expect(result.spawn).toHaveBeenCalledExactlyOnceWith("/bin/bash", ["--noprofile", "--norc", "-lc", "pwd; id -u"],
      expect.objectContaining({ cwd: f.repositoryDirectory,
        env: expect.objectContaining({ USER: "zeros-engine", PATH: `${f.runtime.binRoot}:/usr/bin:/bin` }) }));
  });
});
