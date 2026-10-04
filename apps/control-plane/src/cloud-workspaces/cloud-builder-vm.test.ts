import { describe, expect, it, vi } from "vitest";
import { builderFixedCommand, parseBuilderDiagnostic } from "./cloud-builder-commands.js";
import { BuilderVmError } from "./cloud-builder-vm.js";
import { builderFixture, builderIntent, BUILDER_SANDBOX, BUILDER_WALLET, diagnostic, encodeInstaller, installerInput } from "./cloud-builder-vm-test-fixtures.js";

describe("short-lived Boat builder VMs", () => {
  it.each(["ready", "idle", "running"])("journals before creating, verifies the wallet and accepts %s", async ready => {
    const f = builderFixture();
    f.state.states = ["provisioning", ready];
    const vm = await f.vms.create(builderIntent);
    expect(vm).toEqual({ sandboxId: BUILDER_SANDBOX, purpose: "runtime-qualification", operationKey: builderIntent.operationKey });
    expect((await f.operations.find(vm.operationKey))?.state).toBe("ready");
    const request = f.fetcher.mock.calls[0][1]!;
    expect(new Headers(request.headers).get("x-boat-org")).toBe(BUILDER_WALLET);
    expect(JSON.parse(String(request.body))).toEqual({ from: "zeros-v2-test-base", name: builderIntent.name,
      type: "default", ttlSeconds: 1800, noEnv: true, env: {}, snapshots: false });
    await expect(f.vms.create(builderIntent)).resolves.toEqual(vm);
    expect(f.state.creates).toBe(1);
    await expect(f.vms.create({ ...builderIntent, ttlSeconds: 600 })).rejects.toMatchObject({ code: "provider_operation_conflict" });
  });
  it("replays the same provider operation after a lost create reply", async () => {
    const f = builderFixture(); f.state.createRepliesLost = 1;
    await f.vms.create(builderIntent);
    expect(f.state.creates).toBe(2);
    expect(f.state.allocations.size).toBe(1);
    expect((await f.operations.find(builderIntent.operationKey))?.create_dispatched_at).toBeInstanceOf(Date);
  });
  it.each(["idle", "waiting_for_runtime"])("waits through bootstrap failures and stopped until the base is %s", async hostState => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    f.state.hostState = hostState;
    f.state.baseStatusReplies = [{ success: false, exitCode: 1 }, { timedOut: true },
      { stdout: "private boot output" }, { hostState: "stopped" }];
    await expect(f.vms.waitForBase(vm)).resolves.toMatchObject({ hostState });
    expect(f.state.baseStatusCalls).toBe(5);
    expect(f.waits).toEqual([3000, 3000, 3000, 3000]);
  });
  it.each([["stopped", "timeout"], ["failed", "builder_stopped"]])("fails closed when bootstrap stays %s", async (hostState, check) => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    f.state.hostState = hostState;
    const result = f.vms.waitForBase(vm);
    await expect(result).rejects.toBeInstanceOf(BuilderVmError);
    await expect(result).rejects.toMatchObject({ check, message: `Builder VM ${check}` });
    expect(f.waits.reduce((sum, ms) => sum + ms, 0)).toBe(hostState === "stopped" ? 18_000 : 0);
  });
  it("does not accept a ready probe that returns after the readiness deadline", async () => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    const fetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (...args) => { f.advance(18_001); return fetch(...args); });
    await expect(f.vms.waitForBase(vm)).rejects.toMatchObject({ check: "timeout" });
  });
  it("fails closed at the deadline even with less than Boat's minimum request timeout remaining", async () => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    const find = f.operations.find.bind(f.operations);
    vi.spyOn(f.operations, "find").mockImplementationOnce(async key => { f.advance(17_950); return find(key); });
    const fetch = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementationOnce(async (...args) => { f.advance(51); return fetch(...args); });
    await expect(f.vms.waitForBase(vm)).rejects.toMatchObject({ check: "timeout", message: "Builder VM timeout" });
  });
  it.each(["error", "cancelled", "archived"])("retains the cleanup identity when readiness reports %s", async status => {
    const f = builderFixture(); f.state.states = [status];
    await expect(f.vms.create(builderIntent)).rejects.toMatchObject({ check: "builder_stopped" });
    expect((await f.operations.find(builderIntent.operationKey))?.sandbox_id).toBe(BUILDER_SANDBOX);
    await f.vms.delete({ sandboxId: BUILDER_SANDBOX, operationKey: builderIntent.operationKey, purpose: builderIntent.purpose });
    expect(f.state.deleted).toBe(true);
  });
  it("rejects a wrong wallet but still allows verified deletion", async () => {
    const f = builderFixture(); f.state.wallet = "another-wallet";
    await expect(f.vms.create(builderIntent)).rejects.toMatchObject({ check: "wallet_mismatch" });
    await f.vms.delete({ sandboxId: BUILDER_SANDBOX, operationKey: builderIntent.operationKey, purpose: builderIntent.purpose });
    const call = f.fetcher.mock.calls.find(([, input]) => input?.method === "DELETE")!;
    expect(new Headers(call[1]?.headers).get("x-ascii-confirm-delete")).toBe(BUILDER_SANDBOX);
    expect((await f.operations.find(builderIntent.operationKey))?.state).toBe("deleted");
    expect(new URL(String(f.fetcher.mock.calls.at(-1)![0])).pathname).toBe(`/api/v1/sandboxes/${BUILDER_SANDBOX}`);
    await f.vms.delete({ sandboxId: BUILDER_SANDBOX, operationKey: builderIntent.operationKey, purpose: builderIntent.purpose });
    expect(f.state.deleteRequests).toBe(1);
  });
  it("does not treat a pending provider deletion as cleanup", async () => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    f.state.deletionStatus = "pending";
    await expect(f.vms.delete(vm)).rejects.toMatchObject({ check: "timeout" });
    expect((await f.operations.find(vm.operationKey))?.state).toBe("deleting");
    f.state.deletionStatus = "completed";
    await f.vms.delete(vm);
    expect(f.state.deleteRequests).toBe(1);
  });
  it.each(["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"])("confirms compute deletion with %s storage retention and a 404", async stage => {
    const f = builderFixture(); const vm = await f.vms.create({ ...builderIntent, purpose: "computer-build" });
    f.state.deletionStatus = "blocked"; f.state.deletionStage = stage; f.state.deletionReleasesCompute = true;
    await expect(f.vms.delete(vm)).resolves.toBeUndefined();
    expect((await f.operations.find(vm.operationKey))?.state).toBe("deleted");
    expect(new URL(String(f.fetcher.mock.calls.at(-1)![0])).pathname).toBe(`/api/v1/sandboxes/${BUILDER_SANDBOX}`);
    expect(f.state.deletionStatus).toBe("blocked");
  });
  it("keeps waiting on storage retention while the sandbox is visible, then resumes the same deletion", async () => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    f.state.deletionStatus = "blocked"; f.state.deletionStage = "waiting_for_uploads";
    await expect(f.vms.delete(vm)).rejects.toMatchObject({ check: "timeout" });
    expect((await f.operations.find(vm.operationKey))?.state).toBe("deleting");
    f.state.deleted = true;
    await expect(f.vms.delete(vm)).resolves.toBeUndefined();
    expect(f.state.deleteRequests).toBe(1);
  });
  it.each([["blocked", "unknown_stage"], ["blocked", null], ["pending", "waiting_for_uploads"],
    ["processing", "waiting_for_uploads"]])("does not confirm %s / %s even when the sandbox is absent", async (status, stage) => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    f.state.deletionStatus = status!; f.state.deletionStage = stage; f.state.deletionReleasesCompute = true;
    await expect(f.vms.delete(vm)).rejects.toMatchObject({ check: "timeout" });
    expect((await f.operations.find(vm.operationKey))?.state).toBe("deleting");
  });
  it("forks an explicitly resolved template with no inherited environment and stops to archived", async () => {
    const f = builderFixture();
    const vm = await f.vms.create({ ...builderIntent, purpose: "computer-build", source: { kind: "template", templateId: "zeros-v2-test-template" } });
    expect(String(f.fetcher.mock.calls[0][0])).toContain("/sandboxes/bx_bcdefghj/fork");
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toMatchObject({ noEnv: true, env: {}, snapshots: true });
    await expect(f.vms.stop(vm)).resolves.toEqual({ archived: true });
    expect((await f.operations.find(vm.operationKey))?.state).toBe("archived");
  });
  it("transports only bounded installer stdin on pinned SSH and closes the key on every command", async () => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    expect(await f.vms.baseStatus(vm)).toMatchObject({ hostState: "waiting_for_runtime", currentRuntimeId: null });
    const input = encodeInstaller();
    expect((await f.vms.runFixed(vm, "install-runtime", input)).diagnostic?.ok).toBe(true);
    expect(f.channel.execute.mock.calls[0][0].stdin).toBe(input.toString());
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain("private-artifact-value");
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain(input.toString());
    expect(f.channel.dispose).toHaveBeenCalledOnce();
    expect((await f.vms.runFixed(vm, "runtime-self-test")).diagnostic?.ok).toBe(true);
    expect(f.channel.execute.mock.calls[1][0].command).toContain(`/opt/zeros-infra/${f.state.runtimeId}/bin/node`);
    expect(f.channel.execute.mock.calls[1][0].stdin).toBe("");
    expect(f.channel.dispose).toHaveBeenCalledTimes(2);
  });
  it("revokes SSH access when execution throws, without propagating private errors", async () => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    f.channel.execute.mockRejectedValueOnce(new Error("private-artifact-value"));
    await expect(f.vms.runFixed(vm, "install-runtime", encodeInstaller())).rejects.toThrow("Builder VM command_unconfirmed");
    expect(String(f.fetcher.mock.calls.at(-1)![1]?.body)).toContain("revoked");
    expect(f.channel.dispose).toHaveBeenCalledOnce();
  });
  it("bounds output even for a misbehaving SSH adapter", async () => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    f.state.sshOutput = "x".repeat(65537);
    await expect(f.vms.runFixed(vm, "install-runtime", encodeInstaller())).rejects.toMatchObject({ check: "command_unconfirmed" });
    f.state.sshOutput = JSON.stringify(diagnostic("installer")); f.state.stdoutTruncated = true;
    await expect(f.vms.runFixed(vm, "install-runtime", encodeInstaller())).rejects.toMatchObject({ check: "command_unconfirmed" });
  });
  it("rejects unknown commands, extra self-test input, setup admission and overlong/expired URLs", async () => {
    const f = builderFixture(); const vm = await f.vms.create(builderIntent);
    for (const [command, input] of [["computer:arbitrary", undefined], ["runtime-self-test", Buffer.from("input")],
      ["install-runtime", Buffer.alloc(65537)]] as const)
      await expect(f.vms.runFixed(vm, command, input)).rejects.toMatchObject({ check: "command_invalid" });
    for (const value of [ { ...installerInput(), purpose: "workspace-setup", setup: "private-admission" },
      { ...installerInput(), artifact: { ...installerInput().artifact, expiresAt: new Date(Date.now() - 1000).toISOString() } },
      { ...installerInput(), artifact: { ...installerInput().artifact, expiresAt: new Date(Date.now() + 901_000).toISOString() } } ])
      await expect(f.vms.runFixed(vm, "install-runtime", encodeInstaller(value))).rejects.toMatchObject({ check: "command_invalid" });
    expect(f.channel.execute).not.toHaveBeenCalled();
    expect(builderFixedCommand("runtime-self-test", "r1-invalid; id")).toBeNull();
  });
});

describe("builder closed diagnostics", () => {
  it("accepts only the final diagnostic with the command's vocabulary and matching exit status", () => {
    const good = JSON.stringify(diagnostic());
    expect(parseBuilderDiagnostic(`ignored output\n${good}\n`, "runtime-self-test", 0)?.ok).toBe(true);
    for (const text of [ `${good}\nprivate-artifact-value`, `${good}\n\n`, JSON.stringify({ ...diagnostic(), failedChecks: ["private_value"] }),
      JSON.stringify({ ...diagnostic(), extra: "private-value" }), JSON.stringify({ ...diagnostic(), stage: "other_stage" }),
      JSON.stringify({ ...diagnostic(), ok: false }), JSON.stringify({ ...diagnostic(), timedOut: true }) ])
      expect(parseBuilderDiagnostic(text, "runtime-self-test", 0)).toBeNull();
    expect(parseBuilderDiagnostic(good, "runtime-self-test", 1)).toBeNull();
    expect(parseBuilderDiagnostic(good, "install-runtime", 0)).toBeNull();
    expect(parseBuilderDiagnostic(JSON.stringify(diagnostic("qualification", ["sqlite_query"])), "runtime-self-test", 1)?.ok).toBe(false);
  });
  it("never logs diagnostic parse failures", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect(parseBuilderDiagnostic("private-artifact-value", "runtime-self-test", 0)).toBeNull(); expect(log).not.toHaveBeenCalled(); }
    finally { log.mockRestore(); }
  });
});
