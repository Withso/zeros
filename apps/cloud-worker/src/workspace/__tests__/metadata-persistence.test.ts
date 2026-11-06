import { open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "../../__tests__/worker-fixtures";
import { WorkspaceService } from "../service";
import { repositoryFixture } from "./repository-fixture";

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const services: WorkspaceService[] = [];
const noPr = async () => ({ prNumber: null, prState: null, prUrl: null });
beforeEach(() => { vi.mocked(open).mockReset().mockImplementation(fs.open); });
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function observeMetadata(directory: string) {
  const counts = { writes: 0, fileSyncs: 0, directorySyncs: 0 };
  const beforeFileSync = vi.fn(async () => {}), beforeDirectorySync = vi.fn(async () => {});
  const path = join(directory, "workspace.json");
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await fs.open(...args), name = String(args[0]);
    const metadata = name.startsWith(`${path}.`) && name.endsWith(".tmp");
    if (metadata) {
      const write = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementation(async (data, options) => {
        counts.writes++; return write(data, options);
      });
    }
    if (metadata || name === directory) {
      const sync = file.sync.bind(file);
      vi.spyOn(file, "sync").mockImplementation(async () => {
        if (metadata) { counts.fileSyncs++; await beforeFileSync(); }
        else { counts.directorySyncs++; await beforeDirectorySync(); }
        return sync();
      });
    }
    return file;
  });
  return { counts, beforeFileSync, beforeDirectorySync };
}

async function setup() {
  const fixture = await repositoryFixture();
  const service = await WorkspaceService.open(fixture.scope, fixture.state, { watch: false, lookupPr: noPr });
  services.push(service);
  return { ...fixture, service };
}

const saved = async (directory: string) => JSON.parse(await readFile(join(directory, "workspace.json"), "utf8"));
const report = (phase: string, counts: ReturnType<typeof observeMetadata>["counts"]) => {
  process.stdout.write(`workspace metadata ${phase}: ${JSON.stringify(counts)}\n`);
};

it("durably initializes missing metadata once", async () => {
  const { scope, state } = await repositoryFixture(), disk = observeMetadata(state);
  const service = await WorkspaceService.open(scope, state, { watch: false, lookupPr: noPr });
  services.push(service);
  expect(await saved(state)).toMatchObject({ workspaceId: scope.workspace.id, root: scope.root, baseBranch: "main", configuredBase: "main" });
  report("initialize", disk.counts);
  expect(disk.counts).toEqual({ writes: 1, fileSyncs: 1, directorySyncs: 1 });
});

it("reopens saved metadata without rewriting a user-selected target or legacy fields", async () => {
  const { scope, state, service: first } = await setup();
  await first.handle("git.changeTarget", { newTarget: "release" }); await first.dispose();
  const bytes = JSON.stringify({ ...await saved(state), legacy: "retained" }, null, 2);
  await writeFile(join(state, "workspace.json"), bytes);
  const disk = observeMetadata(state);
  const second = await WorkspaceService.open(scope, state, { watch: false, lookupPr: noPr });
  services.push(second);
  expect(await second.handle("workspace.get", {})).toMatchObject({ baseBranch: "release" });
  report("reopen", disk.counts);
  expect(disk.counts).toEqual({ writes: 0, fileSyncs: 0, directorySyncs: 0 });
  expect(await readFile(join(state, "workspace.json"), "utf8")).toBe(bytes);
  await second.configure({ ...scope.workspace, baseBranch: "develop" });
  expect(await saved(state)).toMatchObject({ baseBranch: "develop", configuredBase: "develop", legacy: "retained" });
  expect(disk.counts).toEqual({ writes: 1, fileSyncs: 1, directorySyncs: 1 });
});

it("persists real target changes once and skips equivalent config and target requests", async () => {
  const { scope, state, service } = await setup(), disk = observeMetadata(state);
  await service.configure(scope.workspace);
  await service.handle("git.changeTarget", { newTarget: "main" });
  report("unchanged", disk.counts);
  expect(disk.counts).toEqual({ writes: 0, fileSyncs: 0, directorySyncs: 0 });
  await service.handle("git.changeTarget", { newTarget: "release" });
  await service.configure(scope.workspace);
  await service.handle("git.changeTarget", { newTarget: "release" });
  expect(await saved(state)).toMatchObject({ baseBranch: "release", configuredBase: "main" });
  expect(disk.counts).toEqual({ writes: 1, fileSyncs: 1, directorySyncs: 1 });
});

it.each(["main", "release"])("compares a queued %s configuration after the prior durable commit", async baseBranch => {
  const { scope, state, service } = await setup(), disk = observeMetadata(state);
  const entered = deferred(), held = deferred();
  disk.beforeDirectorySync.mockImplementationOnce(async () => { entered.resolve(); await held.promise; });
  const first = service.configure({ ...scope.workspace, baseBranch: "release" });
  await entered.promise;
  let completed = false;
  const second = service.configure({ ...scope.workspace, baseBranch }).then(() => { completed = true; });
  try {
    expect(await service.handle("workspace.get", {})).toMatchObject({ baseBranch: "main" });
    expect(completed).toBe(false);
  } finally { held.resolve(); await Promise.all([first, second]); }
  expect(await service.handle("workspace.get", {})).toMatchObject({ baseBranch });
  expect(await saved(state)).toMatchObject({ baseBranch, configuredBase: baseBranch });
  const writes = baseBranch === "main" ? 2 : 1;
  expect(disk.counts).toEqual({ writes, fileSyncs: writes, directorySyncs: writes });
});

it("joins the durability barrier of a user target change before an unchanged config", async () => {
  const { scope, state, service } = await setup(), disk = observeMetadata(state);
  const entered = deferred(), held = deferred();
  disk.beforeDirectorySync.mockImplementationOnce(async () => { entered.resolve(); await held.promise; });
  const change = service.handle("git.changeTarget", { newTarget: "release" });
  await entered.promise;
  let completed = false;
  const configuration = service.configure(scope.workspace).then(() => { completed = true; });
  try {
    expect(await service.handle("workspace.get", {})).toMatchObject({ baseBranch: "main" });
    expect(completed).toBe(false);
  } finally { held.resolve(); await Promise.all([change, configuration]); }
  expect(await service.handle("workspace.get", {})).toMatchObject({ baseBranch: "release" });
  expect(await saved(state)).toMatchObject({ baseBranch: "release", configuredBase: "main" });
  expect(disk.counts).toEqual({ writes: 1, fileSyncs: 1, directorySyncs: 1 });
});

it.each([
  { failure: "file", baseBranch: "main" }, { failure: "file", baseBranch: "release" },
  { failure: "directory", baseBranch: "main" }, { failure: "directory", baseBranch: "release" },
])("repairs $baseBranch after a failed $failure sync without publishing the failed state", async ({ failure, baseBranch }) => {
  const { scope, state, service } = await setup(), disk = observeMetadata(state);
  (failure === "file" ? disk.beforeFileSync : disk.beforeDirectorySync).mockRejectedValueOnce(new Error("fixture sync failed"));
  await expect(service.configure({ ...scope.workspace, baseBranch: "release" })).rejects.toThrow("fixture sync failed");
  expect(await service.handle("workspace.get", {})).toMatchObject({ baseBranch: "main" });
  expect(await saved(state)).toMatchObject({ baseBranch: failure === "file" ? "main" : "release" });
  await service.configure({ ...scope.workspace, baseBranch });
  expect(await service.handle("workspace.get", {})).toMatchObject({ baseBranch });
  expect(await saved(state)).toMatchObject({ baseBranch, configuredBase: baseBranch });
  expect(disk.counts).toEqual({ writes: 2, fileSyncs: 2, directorySyncs: failure === "file" ? 1 : 2 });
  expect((await readdir(state)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

it.each(["open", "reconfigure"])("serves ENGINE_READY and the first workspace read without an unchanged metadata sync on %s", async phase => {
  const fixture = await setup(); await fixture.service.dispose();
  const relay = new FakeRelay();
  const worker = new CloudWorker({ transport: relay, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { watch: false, lookupPr: noPr }, prepareCheckout: async () => {}, drivers: {} });
  const current = { ...config, workspace: fixture.scope.workspace, agents: {} };
  const entered = deferred(), held = deferred();
  let work: Promise<void> | undefined;
  worker.start();
  try {
    if (phase === "reconfigure") await relay.receive(current);
    const disk = observeMetadata(fixture.state);
    disk.beforeFileSync.mockImplementationOnce(async () => { entered.resolve(); await held.promise; });
    const configuring = relay.receive({ ...current, loginRevision: phase === "reconfigure" ? "1" : "0" });
    const opening = relay.receive({ t: "open", clientId: CLIENT_A });
    const request = browserFrame("WORKSPACE_REQUEST", { op: "workspace.list", params: {} });
    work = Promise.all([configuring, opening]).then(async () => { await relay.request(CLIENT_A, request); });
    const outcome = await Promise.race([work.then(() => "ready"), entered.promise.then(() => "metadata-write")]);
    report(`worker-${phase}`, disk.counts);
    expect(outcome).toBe("ready");
    expect(relay.bridge("ENGINE_READY")).toHaveLength(1);
    expect(relay.response(request.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", result: {
      workspaces: [expect.objectContaining({ branch: "workspace/fixture", baseBranch: "main" })],
    } });
    expect(disk.counts).toEqual({ writes: 0, fileSyncs: 0, directorySyncs: 0 });
  } finally { held.resolve(); await Promise.allSettled([work]); await worker.dispose(); }
});
