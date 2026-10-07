import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerMain } from "./worker-cli";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";
import { workerEnvironment } from "./worker-test-fixtures";

const candidate = "a".repeat(40), selected = "b".repeat(40), directories: string[] = [];
const identity = (qualified = false) => ({ version: 1, ready: true, sourceSha: candidate, channel: "alpha", maintenance: false,
  migrations: { state: "current", head: "0121_example.sql", expectedHead: "0121_example.sql", manifestSha256: "c".repeat(64) },
  cloud: { enabled: true, ready: true, state: "healthy" }, workerQualified: qualified,
  worker: { provider: "boat", imageRef: `boat:test-old@sha256:${"c".repeat(64)}`, sourceSha: selected, architecture: "linux/amd64", storageMiB: 4096 } });
async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-worker-cli-test-")); directories.push(directory);
  const events: string[] = [];
  const deps = { directory, assertCheckout: vi.fn(async () => { events.push("checkout"); }), assertNoAgentEnv: vi.fn(async () => {}), assertTrigger: vi.fn(async () => {}),
    hash: vi.fn(async () => "c".repeat(64)), changes: vi.fn(async () => ["apps/desktop/src/engine/agents/adapters/codex/adapter.ts"]),
    assertCI: vi.fn(async () => { events.push("ci"); }), assertCurrent: vi.fn(async () => { events.push("current"); }),
    readIdentity: vi.fn(async () => { events.push("api"); return identity(); }),
    log: vi.fn() };
  return { directory, deps, events, env: { ...workerEnvironment(), GITHUB_OUTPUT: path.join(directory, "output") } };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("worker CLI ordered execution", () => {
  it("reconciles retained native storage under guarded source without qualification or a new receipt", async () => {
    const test = await harness(), reconcile = vi.fn(async () => 1);
    const env = { ...test.env, ZEROS_WORKER_PROMOTION: "disabled", WORKER_RECONCILE_STORAGE: "true", WORKER_EXECUTE: "false" };
    expect(await workerMain("--reconcile-storage", env, { ...test.deps, reconcile } as any)).toEqual({ receiptIssued: false, reconciled: 1 });
    expect(reconcile).toHaveBeenCalledWith(env);
    expect(test.events).toEqual(["checkout", "ci", "current", "api"]);
    expect(await readFile(test.env.GITHUB_OUTPUT, "utf8")).not.toContain("receipt_issued=true");
    await expect(readFile(path.join(test.directory, "worker-receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([{ WORKER_RECONCILE_STORAGE: "false", WORKER_EXECUTE: "false" }, { WORKER_RECONCILE_STORAGE: "true", WORKER_EXECUTE: "true" }])("refuses conflicting or absent reconciliation intent %j", async flags => {
    const test = await harness(), reconcile = vi.fn(async () => 1);
    await expect(workerMain("--reconcile-storage", { ...test.env, ...flags }, { ...test.deps, reconcile } as any)).rejects.toThrow();
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("keeps plans credential-free and does not turn disabled execution into a receipt", async () => {
    const test = await harness();
    expect(await workerMain("--plan", { ...test.env, ZEROS_WORKER_PROMOTION: "disabled" }, test.deps as any)).toEqual({ receiptIssued: false });
    expect(test.deps.assertCI).not.toHaveBeenCalled(); expect(test.deps.readIdentity).not.toHaveBeenCalled();
    await expect(workerMain("--execute", { ...test.env, ZEROS_WORKER_PROMOTION: "disabled" }, test.deps as any)).rejects.toThrow("disabled");

  });
  it.each([false, true])("refuses enabled execution without qualification or reuse (qualified=%s)", async qualified => {
    const test = await harness(); test.deps.readIdentity.mockResolvedValue(identity(qualified));
    await expect(workerMain("--execute", test.env, test.deps)).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(test.deps.changes).not.toHaveBeenCalled(); expect(test.deps.hash).not.toHaveBeenCalled();
    expect(test.deps.assertCI).not.toHaveBeenCalled(); expect(test.deps.readIdentity).not.toHaveBeenCalled();
    await expect(readFile(path.join(test.directory, "worker-receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
