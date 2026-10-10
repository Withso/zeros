import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
const fixture = vi.hoisted(() => ({
  root: "", head: "a".repeat(40), version: 4, failPublish: false, layout: {} as Record<string, unknown>,
  owners: new Map<string, [number, number]>(), renames: [] as [string, string][], spawn: vi.fn(),
}));
vi.mock("../cloud-workspace-validation/sandbox/runtime-layout.json", () => ({ default: fixture.layout }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: fixture.spawn }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof fs>();
  return { ...actual,
    chownSync: (file: fs.PathLike, uid: number, gid: number) => fixture.owners.set(String(file), [uid, gid]),
    lstatSync: (file: fs.PathLike) => {
      const metadata = actual.lstatSync(file), [uid, gid] = fixture.owners.get(String(file)) ?? [0, 0];
      return Object.assign(metadata, { uid, gid });
    },
    fstatSync: (fd: number) => Object.assign(actual.fstatSync(fd), { uid: 0, gid: 0 }),
    renameSync: (source: fs.PathLike, target: fs.PathLike) => {
      const from = String(source), to = String(target);
      if (actual.lstatSync(source).isDirectory()) {
        const files = `${fixture.root}/srv/zeros/files/`;
        // Model the bind mount boundary, even when both mounts have st_dev
        // equal. Testing a device comparison alone would miss Linux EXDEV.
        if (fixture.version === 4 && from.startsWith(files) !== to.startsWith(files))
          throw Object.assign(new Error("cross-mount directory rename"), { code: "EXDEV" });
        if (fixture.failPublish && from.endsWith("/repository") && to.endsWith("/workspace"))
          throw Object.assign(new Error("interrupted publication"), { code: "EIO" });
        fixture.renames.push([from, to]);
      }
      actual.renameSync(source, target);
      for (const [file, owner] of [...fixture.owners]) {
        if (file === from || file.startsWith(from + "/")) {
          fixture.owners.delete(file);
          fixture.owners.set(to + file.slice(from.length), owner);
        }
      }
    },
  };
});

const commit = "a".repeat(40);
const cloneUrl = "https://github.com/example/repository.git";
const material = {
  execution: { workspaceId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222",
    setupRunId: "33333333-3333-4333-8333-333333333333", generation: 1, executionFence: 1 },
  repository: { revision: commit, cloneUrl, credential: { token: "fixture-credential" } },
  settings: { version: 1, snapshotSha256: "b".repeat(64), document: { values: {} }, setupCommands: [] },
};
function directory(file: string, owner = 0, mode = 0o755) {
  fs.mkdirSync(file, { recursive: true, mode });
  fs.chmodSync(file, mode);
  fixture.owners.set(file, [owner, owner]);
}
async function setup(version = 4) {
  fixture.version = version;
  const { prepareRepositoryAndSettings } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
  return prepareRepositoryAndSettings(material, { version, engineUid: 10003, engineGid: 10003,
    setupDirectory: `${fixture.root}/srv/zeros/setup`, managedSettingsDirectory: `${fixture.root}/srv/zeros/managed-settings` },
  async () => "");
}
beforeEach(() => {
  vi.resetModules();
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-setup-persistence-"));
  const layout = JSON.parse(fs.readFileSync(path.resolve("scripts/cloud-workspace-validation/sandbox/runtime-layout.json"), "utf8"));
  Object.assign(fixture.layout, Object.fromEntries(Object.entries(layout).map(([key, value]) =>
    [key, typeof value === "string" && value.startsWith("/srv/zeros") ? fixture.root + value : value])));
  fixture.version = 4; fixture.head = commit; fixture.failPublish = false; fixture.renames.length = 0; fixture.owners.clear();
  directory(`${fixture.root}/srv/zeros/files`);
  directory(`${fixture.root}/srv/zeros/files/.zeros-setup`, 0, 0o710);
  fixture.owners.set(`${fixture.root}/srv/zeros/files/.zeros-setup`, [0, 10001]);
  directory(`${fixture.root}/srv/zeros/home/engine`, 10003);
  directory(`${fixture.root}/srv/zeros/files/workspace`, 10003, 0o700);
  directory(`${fixture.root}/srv/zeros/files/workspace/.git`, 10003, 0o700);
  fs.writeFileSync(`${fixture.root}/srv/zeros/files/workspace/seed`, "original checkout");
  fixture.spawn.mockClear();
  fixture.spawn.mockImplementation((_file: string, args: string[], options: { cwd: string; env: { HOME: string } }) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      const cwd = options.cwd;
      if (args.includes("init")) directory(`${cwd}/.git`, 10003, 0o700);
      if (args.includes("checkout")) fs.writeFileSync(`${cwd}/cloned`, "verified clone");
      if (cwd.includes("/.zeros-engine-setup/")) {
        // Git is UID/GID 10003; it must be able to traverse the root-owned
        // private parent to reach its 0700 staging directory and home.
        const parent = `${fixture.root}/srv/zeros/files/.zeros-engine-setup`;
        expect(fs.lstatSync(parent).mode & 0o777).toBe(0o710);
        expect(fixture.owners.get(parent)).toEqual([0, 10003]);
        expect(options.env.HOME.startsWith(parent + "/")).toBe(true);
      }
      const stdout = args.includes("--show-toplevel") ? cwd : args.includes("--absolute-git-dir") ? `${cwd}/.git`
        : args.includes("--verify") ? fixture.head : args.includes("get-url") ? cloneUrl : "";
      child.stdout.end(Buffer.from(stdout + "\n")); child.stderr.end(); child.emit("close", 0, null);
    });
    return child;
  });
});
afterEach(() => { fs.rmSync(fixture.root, { recursive: true, force: true }); vi.restoreAllMocks(); });

it("stages, publishes and backs up v4 checkouts entirely within the files bind", async () => {
  await expect(setup()).resolves.toBe(commit);
  const files = `${fixture.root}/srv/zeros/files`;
  expect(fixture.renames).toHaveLength(2);
  for (const pair of fixture.renames) for (const file of pair) expect(file.startsWith(files + "/")).toBe(true);
  expect(fs.readFileSync(`${files}/workspace/cloned`, "utf8")).toBe("verified clone");
  expect(fs.readFileSync(`${files}/.zeros-engine-setup/seed/seed`, "utf8")).toBe("original checkout");
  expect(fixture.owners.get(`${files}/.zeros-setup`)).toEqual([0, 10001]);
  expect(fixture.owners.get(`${fixture.root}/srv/zeros/managed-settings`)).toEqual([0, 10001]);
  expect(fixture.owners.get(`${fixture.root}/srv/zeros/managed-settings/settings.managed.toml`)).toEqual([0, 10001]);
  expect(fs.existsSync(`${fixture.root}/srv/zeros/.zeros-image-seed`)).toBe(false);
  // An idempotent setup consumes the same private backup and journal.
  await expect(setup()).resolves.toBe(commit);
  expect(fixture.renames).toHaveLength(2);
});

it("restores the previous v4 checkout after an interrupted publication without crossing mounts", async () => {
  fixture.failPublish = true;
  await expect(setup()).rejects.toMatchObject({ code: "EIO" });
  expect(fs.readFileSync(`${fixture.root}/srv/zeros/files/workspace/seed`, "utf8")).toBe("original checkout");
  expect(fixture.renames).toHaveLength(2);
  expect(fs.readdirSync(`${fixture.root}/srv/zeros/files/.zeros-engine-setup`)).toEqual([]);
  fixture.failPublish = false;
  await expect(setup()).resolves.toBe(commit);
});

it("reuses the v4 seed after publication completed before the journal was written", async () => {
  await setup();
  fs.unlinkSync(`${fixture.root}/srv/zeros/setup/repository.json`);
  const renames = [...fixture.renames];
  await expect(setup()).resolves.toBe(commit);
  expect(fixture.renames).toEqual(renames);
});

it("reuses the original staging seed and actual checkout without recloning after the path switch", async () => {
  const files = `${fixture.root}/srv/zeros/files`;
  const legacySeed = `${files}/.zeros-setup/seed`;
  directory(legacySeed, 10003, 0o700);
  fs.writeFileSync(`${legacySeed}/original`, "preserved seed");
  await expect(setup()).resolves.toBe(commit);
  expect(fixture.renames).toEqual([]);
  expect(fixture.spawn.mock.calls.some(([, args]) => args.includes("fetch") || args.includes("checkout"))).toBe(false);
  expect(fs.readFileSync(`${legacySeed}/original`, "utf8")).toBe("preserved seed");
  expect(fixture.owners.get(`${files}/.zeros-setup`)).toEqual([0, 10001]);
  expect(fixture.spawn.mock.calls.every(([, , options]) => options.env.HOME === `${fixture.root}/srv/zeros/home/engine`)).toBe(true);
});

it("recovers a missing checkout from the original seed on the same files bind", async () => {
  const files = `${fixture.root}/srv/zeros/files`, legacySeed = `${files}/.zeros-setup/seed`;
  fs.renameSync(`${files}/workspace`, legacySeed); fixture.renames.length = 0;
  await expect(setup()).resolves.toBe(commit);
  expect(fixture.renames[0]).toEqual([legacySeed, `${files}/workspace`]);
  expect(fs.readFileSync(`${files}/.zeros-engine-setup/seed/seed`, "utf8")).toBe("original checkout");
  expect(fs.readFileSync(`${files}/workspace/cloned`, "utf8")).toBe("verified clone");
  expect(fixture.renames.every(pair => pair.every(file => file.startsWith(files + "/")))).toBe(true);
  expect(fixture.owners.get(`${files}/.zeros-setup`)).toEqual([0, 10001]);
});

it("refuses simultaneous old and current seeds before overwriting or moving either", async () => {
  const files = `${fixture.root}/srv/zeros/files`;
  directory(`${files}/.zeros-engine-setup`, 0, 0o710);
  fixture.owners.set(`${files}/.zeros-engine-setup`, [0, 10003]);
  for (const staging of [".zeros-setup", ".zeros-engine-setup"]) {
    directory(`${files}/${staging}/seed`, 10003, 0o700);
    fs.writeFileSync(`${files}/${staging}/seed/original`, staging);
  }
  await expect(setup()).rejects.toMatchObject({ code: "image_contract_invalid" });
  expect(fixture.renames).toEqual([]);
  for (const staging of [".zeros-setup", ".zeros-engine-setup"])
    expect(fs.readFileSync(`${files}/${staging}/seed/original`, "utf8")).toBe(staging);
});

it("refuses legacy setup before changing checkout or preparation journals", async () => {
  await expect(setup(3)).rejects.toMatchObject({ code: "cloud_workspace_v2_required" });
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(fixture.renames).toEqual([]);
  expect(fs.readFileSync(`${fixture.root}/srv/zeros/files/workspace/seed`, "utf8")).toBe("original checkout");
});

it.each([
  { keySha256: ["d".repeat(64)] },
  { mode: "resume_existing", proofEpoch: ["44444444-4444-4444-8444-444444444444"] },
])("does not publish completion from a coercible but non-string preparation identity (%j)", async invalid => {
  await setup();
  const helper = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
  const setupDirectory = `${fixture.root}/srv/zeros/setup`;
  helper.saveCompletedCloudWorkspacePreparation({ ...material,
    engine: { instanceId: "44444444-4444-4444-8444-444444444444" },
    resume: { version: 1, mode: "prepare_generation", keySha256: "d".repeat(64), proofEpoch: null, ...invalid },
  }, { version: 4, setupDirectory });
  expect(fs.existsSync(`${setupDirectory}/resume.json`)).toBe(false);
});

it("reuses only an exact completed enrollment and leaves dirty files, Design and conversation bytes alone", async () => {
  await setup();
  const helper = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
  const profile = { version: 4, engineUid: 10003, engineGid: 10003,
    setupDirectory: `${fixture.root}/srv/zeros/setup`, managedSettingsDirectory: `${fixture.root}/srv/zeros/managed-settings` };
  const engineId = "44444444-4444-4444-8444-444444444444";
  const prepared = { ...material, engine: { instanceId: engineId },
    resume: { version: 1, mode: "prepare_generation", keySha256: "d".repeat(64), proofEpoch: null } };
  const waking = { ...prepared, engine: { instanceId: "55555555-5555-4555-8555-555555555555" },
    resume: { ...prepared.resume, mode: "resume_existing", proofEpoch: engineId } };
  expect(await helper.readCompletedCloudWorkspacePreparation(waking, profile, async () => "")).toBeNull();
  helper.saveCompletedCloudWorkspacePreparation(prepared, profile);
  const files = `${fixture.root}/srv/zeros/files/workspace`;
  for (const name of ["dirty.txt", "design.html", "engine.sqlite"]) fs.writeFileSync(`${files}/${name}`, `preserved ${name}`);
  fixture.spawn.mockClear();
  fixture.head = "f".repeat(40); // Preserve commits made by the owner after setup.
  expect(await helper.readCompletedCloudWorkspacePreparation(waking, profile, async () => "")).toBe(fixture.head);
  expect(fixture.spawn.mock.calls.every(([, args]) => !args.some((arg: string) => ["checkout", "init", "fetch", "reset"].includes(arg)))).toBe(true);
  for (const name of ["dirty.txt", "design.html", "engine.sqlite"]) expect(fs.readFileSync(`${files}/${name}`, "utf8")).toBe(`preserved ${name}`);
  for (const resume of [{ ...waking.resume, keySha256: "e".repeat(64) },
    { ...waking.resume, proofEpoch: waking.engine.instanceId }, { ...waking.resume, mode: "prepare_generation", proofEpoch: null }])
    expect(await helper.readCompletedCloudWorkspacePreparation({ ...waking, resume }, profile, async () => "")).toBeNull();
  expect(await helper.readCompletedCloudWorkspacePreparation(waking, { ...profile, version: 3 }, async () => "")).toBeNull();
  const journalPath = `${profile.setupDirectory}/repository.json`;
  const journal = fs.readFileSync(journalPath, "utf8");
  fs.writeFileSync(journalPath, JSON.stringify({ ...JSON.parse(journal), commandState: "failed" }));
  expect(await helper.readCompletedCloudWorkspacePreparation(waking, profile, async () => "")).toBeNull();
  fs.writeFileSync(journalPath, journal);
  const settingsPath = `${profile.managedSettingsDirectory}/settings.managed.toml`;
  fs.writeFileSync(settingsPath, "changed settings");
  expect(await helper.readCompletedCloudWorkspacePreparation(waking, profile, async () => "")).toBeNull();
  fs.writeFileSync(settingsPath, "");
  fs.renameSync(`${files}/.git`, `${files}/.git-real`);
  fs.symlinkSync(`${files}/.git-real`, `${files}/.git`);
  expect(await helper.readCompletedCloudWorkspacePreparation(waking, profile, async () => "")).toBeNull();
  fs.unlinkSync(`${files}/.git`);
  fs.renameSync(`${files}/.git-real`, `${files}/.git`);
  fs.writeFileSync(`${profile.setupDirectory}/resume.json`, "corrupt");
  expect(await helper.readCompletedCloudWorkspacePreparation(waking, profile, async () => "")).toBeNull();
  await expect(setup()).resolves.toBe(fixture.head);
  for (const name of ["dirty.txt", "design.html", "engine.sqlite"]) expect(fs.readFileSync(`${files}/${name}`, "utf8")).toBe(`preserved ${name}`);
});
