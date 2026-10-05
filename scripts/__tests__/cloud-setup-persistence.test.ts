import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  root: "", version: 4, failPublish: false, layout: {} as Record<string, unknown>,
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
  fixture.version = 4; fixture.failPublish = false; fixture.renames.length = 0; fixture.owners.clear();
  directory(`${fixture.root}/srv/zeros/files`);
  directory(`${fixture.root}/srv/zeros/files/workspace`, 10001, 0o700);
  directory(`${fixture.root}/srv/zeros/files/workspace/.git`, 10001, 0o700);
  fs.writeFileSync(`${fixture.root}/srv/zeros/files/workspace/seed`, "original checkout");
  fixture.spawn.mockImplementation((_file: string, args: string[], options: { cwd: string; env: { HOME: string } }) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      const cwd = options.cwd;
      if (args.includes("init")) directory(`${cwd}/.git`, 10001, 0o700);
      if (args.includes("checkout")) fs.writeFileSync(`${cwd}/cloned`, "verified clone");
      if (cwd.includes("/.zeros-setup/")) {
        // Git is UID/GID 10001; it must be able to traverse the root-owned
        // private parent to reach its 0700 staging directory and home.
        const parent = `${fixture.root}/srv/zeros/files/.zeros-setup`;
        expect(fs.lstatSync(parent).mode & 0o777).toBe(0o710);
        expect(fixture.owners.get(parent)).toEqual([0, 10001]);
        expect(options.env.HOME.startsWith(parent + "/")).toBe(true);
      }
      const stdout = args.includes("--show-toplevel") ? cwd : args.includes("--absolute-git-dir") ? `${cwd}/.git`
        : args.includes("--verify") ? commit : args.includes("get-url") ? cloneUrl : "";
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
  expect(fs.readFileSync(`${files}/.zeros-setup/seed/seed`, "utf8")).toBe("original checkout");
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
  expect(fs.readdirSync(`${fixture.root}/srv/zeros/files/.zeros-setup`)).toEqual([]);
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

it("keeps the legacy staging and seed paths unchanged", async () => {
  await expect(setup(3)).resolves.toBe(commit);
  expect(fs.readFileSync(`${fixture.root}/srv/zeros/.zeros-image-seed/seed`, "utf8")).toBe("original checkout");
  expect(fs.existsSync(`${fixture.root}/srv/zeros/files/.zeros-setup`)).toBe(false);
});
