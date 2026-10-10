import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudBootNativeAuthority } from "../cloud-provider-execution";
import { bootClaudeExecutionFixture } from "../adapters/claude-sdk/__tests__/helpers/boot-execution";

vi.mock("../containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("./helpers/test-cloud-runtime")).testCloudRuntime,
}));

type Fixture = Awaited<ReturnType<typeof bootClaudeExecutionFixture>>;
const fixtures: Fixture[] = [];
let dataRoot: string;
beforeEach(async () => {
  dataRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-idle-boot-")));
  vi.stubEnv("ZEROS_DATA_DIR", dataRoot);
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(dataRoot, { recursive: true, force: true });
});
async function fixture() {
  const value = await bootClaudeExecutionFixture(); fixtures.push(value); return value;
}
async function settleFirstTurn(value: Fixture) {
  const token = value.factory.reserveBootTurn(value.execution, value.selection);
  value.factory.markNativeHandoff(value.execution, token);
  await value.factory.settleBootTurn(value.execution, token);
}

describe("original idle boot host retirement", () => {
  it("keeps a prepared cold host reserved until its first native turn settles", async () => {
    const f = await fixture();
    expect(f.factory.idleBootExecutions()).toEqual([]);
    await expect(f.factory.retireIdleBootExecution(f.execution)).resolves.toBe(false);
    expect(f.execution.lifetime.signal.aborted).toBe(false);
    const token = f.factory.reserveBootTurn(f.execution, f.selection);
    f.factory.markNativeHandoff(f.execution, token);
  });
  it("positively retires the exact idle original without any authority fetch", async () => {
    const f = await fixture(); await settleFirstTurn(f);
    f.request.bootstrap.mockClear(); f.request.sync.mockClear();
    const idle = f.factory.idleBootExecutions();
    expect(idle).toEqual([f.execution]); expect(idle[0]).toBe(f.execution);
    expect(Object.isFrozen(idle)).toBe(true);
    await expect(f.factory.retireIdleBootExecution(f.execution)).resolves.toBe(true);
    expect(f.execution.lifetime.signal.aborted).toBe(true);
    expect(f.factory.bootScopeActivity([]).scopes).toEqual([]);
    expect(f.request.bootstrap).not.toHaveBeenCalled(); expect(f.request.sync).not.toHaveBeenCalled();
  });
  it("preserves a new ORIGINAL warm selection captured before turn reservation", async () => {
    const f = await fixture(); await settleFirstTurn(f);
    const next = f.factory.selectBoot(f.input);
    expect(f.factory.idleBootExecutions()).toEqual([]);
    await expect(f.factory.retireIdleBootExecution(f.execution)).resolves.toBe(false);
    expect(f.factory.canReuseBootExecution(f.execution, next)).toBe(true);
    expect(f.execution.lifetime.signal.aborted).toBe(false);
  });
  it("preserves reserved and entered follow-up turns on that warm host", async () => {
    const f = await fixture(); await settleFirstTurn(f);
    const next = f.factory.selectBoot(f.input), token = f.factory.reserveBootTurn(f.execution, next);
    await expect(f.factory.retireIdleBootExecution(f.execution)).resolves.toBe(false);
    f.factory.markNativeHandoff(f.execution, token);
    expect(f.factory.idleBootExecutions()).toEqual([]);
    await expect(f.factory.retireIdleBootExecution(f.execution)).resolves.toBe(false);
    await f.factory.settleBootTurn(f.execution, token);
    await expect(f.factory.retireIdleBootExecution(f.execution)).resolves.toBe(true);
  });
  it("retains background descendants and their authority after foreground settlement", async () => {
    const f = await fixture();
    vi.spyOn(f.execution.coordinator, "hasBackgroundServers").mockResolvedValue(true);
    await settleFirstTurn(f);
    expect(f.factory.bootScopeActivity([]).background).toBe(1);
    expect(f.factory.idleBootExecutions()).toEqual([]);
    await expect(f.factory.retireIdleBootExecution(f.execution)).resolves.toBe(false);
    expect(f.execution.lifetime.signal.aborted).toBe(false);
  });
  it("fences the original host synchronously before a held positive Stop proof", async () => {
    const f = await fixture(); await settleFirstTurn(f);
    const originalStop = f.execution.coordinator.stopAndProve;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.execution.coordinator, "stopAndProve").mockImplementationOnce(async () => {
      await held; await originalStop();
    });
    const retiring = f.factory.retireIdleBootExecution(f.execution);
    expect(f.execution.lifetime.signal.aborted).toBe(true);
    expect(f.factory.canRetainBootExecution(f.input)).toBe(false);
    expect(() => f.factory.selectBoot(f.input)).toThrow();
    const replacement = f.factory.selectBoot({ ...f.input, executionId: randomUUID() });
    expect(() => cloudBootNativeAuthority(replacement).lifetime.assertLive()).not.toThrow();
    release(); await expect(retiring).resolves.toBe(true);
    expect(() => cloudBootNativeAuthority(replacement).lifetime.assertLive()).not.toThrow();
  });
  it("does not retire a replacement when a delayed old idle reference is retried", async () => {
    const f = await fixture(); await settleFirstTurn(f);
    await f.factory.retireIdleBootExecution(f.execution);
    const replacement = f.factory.selectBoot({ ...f.input, executionId: randomUUID() });
    await expect(f.factory.retireIdleBootExecution(f.execution)).resolves.toBe(false);
    expect(cloudBootNativeAuthority(replacement).lifetime.signal.aborted).toBe(false);
  });
  it("retains failed retirement and permits exact original lifetime cleanup retry", async () => {
    const f = await fixture(); await settleFirstTurn(f);
    vi.spyOn(f.execution.coordinator, "stopAndProve").mockRejectedValueOnce(
      Object.assign(new Error("Synthetic failed original proof"), { code: "cloud_containment_attestation_failed" }));
    await expect(f.factory.retireIdleBootExecution(f.execution)).rejects.toMatchObject({ code: "cloud_containment_attestation_failed" });
    expect(f.factory.bootScopeActivity([]).scopes).toHaveLength(1);
    expect(f.factory.idleBootExecutions()).toEqual([]);
    await f.execution.lifetime.close();
    expect(f.factory.bootScopeActivity([]).scopes).toEqual([]);
  });
  it("rejects a copied execution without closing the ORIGINAL host", async () => {
    const f = await fixture(); await settleFirstTurn(f);
    await expect(f.factory.retireIdleBootExecution({ ...f.execution })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(f.execution.lifetime.signal.aborted).toBe(false);
  });
});
