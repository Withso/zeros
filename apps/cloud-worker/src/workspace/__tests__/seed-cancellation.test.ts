import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { seedEnvironment } from "../environment-seed";
import { repositoryFixture } from "./repository-fixture";
import { CloudWorker } from "../../worker";
import { config, FakeRelay } from "../../__tests__/worker-fixtures";

const gate = vi.hoisted(() => ({ path: "", count: 0, target: 0, enter: () => {}, wait: Promise.resolve() }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const result = await actual.lstat(...args);
    if (String(args[0]) === gate.path && ++gate.count === gate.target) { gate.enter(); await gate.wait; }
    return result;
  } };
});
function hold(path: string, target: number) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  Object.assign(gate, { path, count: 0, target, enter, wait: new Promise<void>(resolve => { release = resolve; }) });
  return { entered, release };
}
async function fixture(target: number) {
  const f = await repositoryFixture();
  await writeFile(join(f.root, ".gitignore"), ".env*\n");
  const barrier = hold(join(f.root, ".git/index.lock"), target);
  const environment = { versionId: randomUUID(), repositoryId: "42", variables: {}, files: [{ path: ".env.local", content: "SYNTHETIC=review-value\n" }] };
  return { ...f, barrier, environment };
}
const exists = (path: string) => stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

it.each([1, 2])("cancellation held at ownership check %i prevents initial file publication", async point => {
  const f = await fixture(point), abort = new AbortController();
  const outcome = seedEnvironment(f.scope, f.state, f.environment, abort.signal).then(() => "ready", () => "cancelled");
  try {
    await f.barrier.entered;
    expect(await exists(join(f.root, ".env.local"))).toBe(false);
    abort.abort(); f.barrier.release();
    expect(await outcome).toBe("cancelled");
    expect(await exists(join(f.root, ".env.local"))).toBe(false);
  } finally { f.barrier.release(); await outcome; }
});

it.each(["stop", "dispose"])("actual worker %s fences a seed held at its last lock check", async mode => {
  const f = await fixture(2), reportEnvironment = vi.fn(async () => {});
  const relay = Object.assign(new FakeRelay(), { reportEnvironment });
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, drivers: {},
    workspaceServices: { watch: false }, prepareCheckout: async () => ({ createdBranch: false }) });
  worker.start();
  const configuring = relay.receive({ ...config, agents: {}, workspace: f.scope.workspace, environment: f.environment }).then(() => "ready", () => "cancelled");
  try {
    await f.barrier.entered;
    expect(await exists(join(f.root, ".env.local"))).toBe(false);
    const closing = mode === "stop" ? relay.receive({ t: "stop", id: randomUUID() }) : worker.dispose();
    expect((worker as any).environmentLifetime.signal.aborted).toBe(true);
    f.barrier.release();
    await Promise.all([configuring, closing]);
    expect(await configuring).toBe("cancelled");
    expect(reportEnvironment).not.toHaveBeenCalled();
    expect(await exists(join(f.root, ".env.local"))).toBe(false);
  } finally { f.barrier.release(); await configuring; await worker.dispose(); }
});

it.each([1, 2])("a seed cancelled at ownership check %i remains prepared and can resume", async point => {
  const f = await fixture(point), abort = new AbortController();
  const outcome = seedEnvironment(f.scope, f.state, f.environment, abort.signal).catch(() => {});
  const journal = () => readFile(join(f.state, "environment-seed/manifest.json"), "utf8").then(JSON.parse);
  try {
    await f.barrier.entered; abort.abort(); f.barrier.release(); await outcome;
    expect(await exists(join(f.root, ".env.local"))).toBe(false);
    expect(await journal()).toMatchObject({ complete: false, files: [{ phase: "prepared" }] });
    await seedEnvironment(f.scope, f.state, f.environment, new AbortController().signal);
    expect(await journal()).toMatchObject({ complete: true, files: [{ phase: "complete" }] });
    expect(await readFile(join(f.root, ".env.local"), "utf8") === f.environment.files[0]!.content).toBe(true);
  } finally { f.barrier.release(); await outcome; }
});
