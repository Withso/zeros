import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerMain } from "./worker-cli";
import { workerEnvironment } from "./worker-test-fixtures";

const candidate = "a".repeat(40), selected = "b".repeat(40), directories: string[] = [];
const identity = (qualified = false) => ({ version: 1, ready: true, sourceSha: candidate, channel: "alpha", maintenance: false,
  migrations: { state: "current", head: "0121_example.sql", expectedHead: "0121_example.sql", manifestSha256: "c".repeat(64) },
  cloud: { enabled: true, ready: true, state: "healthy" }, workerQualified: qualified,
  worker: { provider: "boat", imageRef: `boat:test-old@sha256:${"c".repeat(64)}`, sourceSha: selected, architecture: "linux/amd64", storageMiB: 4096 } });
const receipt = () => ({ version: 1, status: "success", channel: "alpha", repository: "example/zeros", branch: "main", runId: "123", runAttempt: "1",
  sourceSha: candidate, inputsSha256: "c".repeat(64), qualificationProfile: "full", qualifiedKinds: ["claude-setup-token", "codex-chatgpt", "cursor-api-key"],
  worker: { provider: "boat", imageRef: `boat:test-new@sha256:${"d".repeat(64)}`, sourceSha: candidate, architecture: "linux/amd64", storageMiB: 4096 },
  runtimeContractSha256: "d".repeat(64), evidenceSha256: "e".repeat(64), approvalPlanSha256: "f".repeat(64), approvalTargetSha256: "0".repeat(64),
  roleDeleted: true, resourcesDeleted: true, completedAt: new Date().toISOString() });
async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-worker-cli-test-")); directories.push(directory);
  const events: string[] = [];
  const deps = { directory, assertCheckout: vi.fn(async () => { events.push("checkout"); }), assertNoAgentEnv: vi.fn(async () => {}), assertTrigger: vi.fn(async () => {}),
    hash: vi.fn(async () => "c".repeat(64)), changes: vi.fn(async () => ["apps/desktop/src/engine/agents/adapters/codex/adapter.ts"]),
    assertCI: vi.fn(async () => { events.push("ci"); }), assertCurrent: vi.fn(async () => { events.push("current"); }),
    readIdentity: vi.fn(async () => { events.push("api"); return identity(); }),
    services: vi.fn(async () => { events.push("services"); return { channel: "alpha", sourceSha: candidate, branch: "main", repository: "example/zeros", completedAt: new Date(Date.now() - 1000).toISOString() }; }),
    execute: vi.fn(async () => { events.push("build-canaries-approval-tuple"); return receipt(); }), log: vi.fn() };
  return { directory, deps, events, env: { ...workerEnvironment(), GITHUB_OUTPUT: path.join(directory, "output") } };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("worker CLI ordered execution", () => {
  it("reconciles retained native storage under guarded source without qualification or a new receipt", async () => {
    const test = await harness(), reconcile = vi.fn(async () => 1);
    const env = { ...test.env, WORKER_RECONCILE_STORAGE: "true", WORKER_EXECUTE: "false" };
    expect(await workerMain("--reconcile-storage", env, { ...test.deps, reconcile } as any)).toEqual({ receiptIssued: false, reconciled: 1 });
    expect(reconcile).toHaveBeenCalledWith(env); expect(test.deps.execute).not.toHaveBeenCalled(); expect(test.deps.services).not.toHaveBeenCalled();
    expect(test.events).toEqual(["checkout", "ci", "current", "api"]);
    expect(await readFile(test.env.GITHUB_OUTPUT, "utf8")).not.toContain("receipt_issued=true");
    await expect(readFile(path.join(test.directory, "worker-receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([{ WORKER_RECONCILE_STORAGE: "false", WORKER_EXECUTE: "false" }, { WORKER_RECONCILE_STORAGE: "true", WORKER_EXECUTE: "true" }])("refuses conflicting or absent reconciliation intent %j", async flags => {
    const test = await harness(), reconcile = vi.fn(async () => 1);
    await expect(workerMain("--reconcile-storage", { ...test.env, ...flags }, { ...test.deps, reconcile } as any)).rejects.toThrow();
    expect(reconcile).not.toHaveBeenCalled(); expect(test.deps.execute).not.toHaveBeenCalled();
  });
  it("keeps plans credential-free and does not turn disabled execution into a receipt", async () => {
    const test = await harness();
    expect(await workerMain("--plan", { ...test.env, ZEROS_WORKER_PROMOTION: "disabled" }, test.deps as any)).toEqual({ receiptIssued: false });
    expect(test.deps.assertCI).not.toHaveBeenCalled(); expect(test.deps.execute).not.toHaveBeenCalled(); expect(test.deps.readIdentity).not.toHaveBeenCalled();
    await expect(workerMain("--execute", { ...test.env, ZEROS_WORKER_PROMOTION: "disabled" }, test.deps as any)).rejects.toThrow("disabled");
    expect(test.deps.execute).not.toHaveBeenCalled();
  });
  it("requires exact-SHA CI and new services/WorkOS proof before spending, then writes the exact success handoff", async () => {
    const test = await harness();
    expect(await workerMain("--execute", test.env, test.deps as any)).toEqual({ receiptIssued: true, artifact: `worker-promotion-alpha-${candidate}` });
    expect(test.events.indexOf("ci")).toBeLessThan(test.events.indexOf("services"));
    expect(test.events.indexOf("services")).toBeLessThan(test.events.indexOf("build-canaries-approval-tuple"));
    expect(test.deps.changes).toHaveBeenLastCalledWith(candidate, selected);
    expect(test.deps.execute).toHaveBeenCalledWith(test.env, "c".repeat(64), "full");
    expect(JSON.parse(await readFile(path.join(test.directory, "worker-receipt.json"), "utf8"))).toMatchObject({ sourceSha: candidate, qualificationProfile: "full", runAttempt: "1" });
    expect(await readFile(test.env.GITHUB_OUTPUT, "utf8")).toContain(`receipt_artifact=worker-promotion-alpha-${candidate}`);
  });
  it("reuses only affirmative current qualification and identical committed worker inputs, without issuing a receipt", async () => {
    const test = await harness(); test.deps.readIdentity.mockResolvedValue(identity(true));
    expect(await workerMain("--execute", test.env, test.deps as any)).toEqual({ receiptIssued: false });
    expect(test.deps.execute).not.toHaveBeenCalled(); expect(test.deps.services).not.toHaveBeenCalled();
  });
  it("produces fresh qualification and a receipt when the hosted callable requires a handoff despite genuine reuse", async () => {
    const test = await harness(); test.deps.readIdentity.mockResolvedValue(identity(true));
    const env = { ...test.env, WORKER_RECEIPT_REQUIRED: "true" };
    expect(await workerMain("--execute", env, test.deps as any)).toEqual({ receiptIssued: true, artifact: `worker-promotion-alpha-${candidate}` });
    expect(test.deps.services).toHaveBeenCalledWith("123");
    expect(test.deps.execute).toHaveBeenCalledWith(env, "c".repeat(64), "full");
    expect(JSON.parse(await readFile(path.join(test.directory, "worker-receipt.json"), "utf8"))).toMatchObject({ runId: "123", runAttempt: "1", sourceSha: candidate });
  });
  it("fails before allocation on CI, source, WorkOS receipt, dirty checkout or fork failures and deletes stale success files", async () => {
    for (const failure of ["assertCI", "assertCheckout", "assertTrigger", "services"]) {
      const test = await harness(); await writeFile(path.join(test.directory, "worker-receipt.json"), JSON.stringify(receipt()));
      (test.deps as any)[failure].mockRejectedValue(new Error("synthetic-gate-failed"));
      await expect(workerMain("--execute", test.env, test.deps as any)).rejects.toThrow("gate-failed");
      expect(test.deps.execute).not.toHaveBeenCalled(); await expect(readFile(path.join(test.directory, "worker-receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const test = await harness(); test.deps.services.mockResolvedValue({ channel: "beta" } as any);
    await expect(workerMain("--execute", test.env, test.deps as any)).rejects.toThrow("services"); expect(test.deps.execute).not.toHaveBeenCalled();
  });
  it("never saves a receipt for rate limits, incomplete qualification, wrong attempt, or missing cleanup", async () => {
    for (const result of [{ ...receipt(), runAttempt: "2" }, { ...receipt(), qualifiedKinds: ["cursor-api-key"] }, { ...receipt(), resourcesDeleted: false },
      { ...receipt(), worker: { ...receipt().worker, provider: "daytona", imageRef: "11111111-1111-4111-8111-111111111111" } },
      { ...receipt(), worker: { ...receipt().worker, architecture: "linux/arm64" } },
      { ...receipt(), completedAt: new Date(Date.now() + 60_000).toISOString() }]) {
      const test = await harness(); test.deps.execute.mockResolvedValue(result as any);
      await expect(workerMain("--execute", test.env, test.deps as any)).rejects.toThrow();
      await expect(readFile(path.join(test.directory, "worker-receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const test = await harness(); test.deps.execute.mockRejectedValue(new Error("canary account rate-limited"));
    await expect(workerMain("--execute", test.env, test.deps as any)).rejects.toThrow("canary account rate-limited");
    expect(await readFile(test.env.GITHUB_OUTPUT, "utf8")).not.toContain("receipt_issued=true");
  });
});
