import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudExecutionAuthorityReceiptSchema, type CloudExecutionEnrollRequest, type CloudExecutionAuthorityOperation } from "@zeros/protocol/cloud-execution-authority";
import { CloudExecutionAuthority, isCloudExecutionWork } from "../agents/cloud-execution-authority";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] }); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const actor = { scope, actorSessionId: randomUUID(), authorityEpoch: 3, confirmedUntilMs: Date.now() + 10_000,
    fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const },
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1, role: "owner" as const, fingerprint: "a".repeat(64) } };
  const request: CloudExecutionEnrollRequest = { version: 1, scope, runtimeId: `r1-${"f".repeat(64)}`, actorSessionId: actor.actorSessionId,
    contextId: randomUUID(), contextRevision: "b".repeat(64), claimId: randomUUID(), command: { commandId: randomUUID(),
      conversationId: randomUUID(), turnId: randomUUID(), executionId: randomUUID(), payloadSha256: "c".repeat(64),
      provider: "claude", model: "qualified-model", cwd: "/srv/zeros/workspace" } };
  const revocation = new AbortController(), stop = new AbortController();
  const expected = { actor, credentialId: randomUUID(), credentialRevision: 2, revocation: revocation.signal, assertAdmission: vi.fn() };
  const receipt = CloudExecutionAuthorityReceiptSchema.parse({ ...request, mode: "boot-execution-v1", acceptedWorkId: randomUUID(), revision: 1,
    actor: actor.actor, fundingGrant: actor.fundingGrant, sourceSessionId: randomUUID(), epochs: { wa: 3, wr: 1, me: 1, ac: 1, dk: 1 },
    credentialId: expected.credentialId, credentialRevision: expected.credentialRevision, acceptedAtMs: Date.now(),
    admissionExpiresAtMs: Date.now() + 10_000, providerExpiresAtMs: Date.now() + 120_000, providerProofVersion: 1 });
  const enroll = vi.fn(async (_request: CloudExecutionEnrollRequest, _signal: AbortSignal): Promise<unknown> => receipt);
  const check = vi.fn(async (_request: CloudExecutionAuthorityOperation, _signal: AbortSignal): Promise<unknown> => ({ version: 1, acceptedWorkId: receipt.acceptedWorkId, state: "current" }));
  const close = vi.fn(async (_request: CloudExecutionAuthorityOperation, _signal: AbortSignal): Promise<unknown> => ({ closed: true })), engineLive = vi.fn(() => true);
  const authority = new CloudExecutionAuthority({ runtimeId: request.runtimeId, enroll, check, close, engineLive });
  cleanup.push(() => authority.dispose());
  return { authority, request, expected, receipt, stop, revocation, enroll, check, close, engineLive,
    accept: () => authority.accept(request, expected, stop.signal) };
}

describe("exact execution-owned authority", () => {
  it("keeps one genuine grant across observation outages without extending the original deadline", async () => {
    const f = fixture(), work = await f.accept();
    expect(isCloudExecutionWork(f.receipt)).toBe(false); expect(isCloudExecutionWork(work)).toBe(true);
    f.check.mockRejectedValue(new Error("synthetic transport outage"));
    await vi.advanceTimersByTimeAsync(119_999);
    work.assertLive(); expect(work.signal.aborted).toBe(false); expect(f.check).toHaveBeenCalledTimes(3);
    await expect(f.accept()).rejects.toThrow(); expect(f.enroll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(work.signal.aborted).toBe(true);
    expect(() => work.assertLive()).toThrow();
  });
  it.each(["context", "claim", "payload", "credential", "actor", "epoch"] as const)("refuses a %s substitution in the CP receipt", async field => {
    const f = fixture(), value = structuredClone(f.receipt);
    if (field === "context") value.contextId = randomUUID();
    if (field === "claim") value.claimId = randomUUID();
    if (field === "payload") value.command.payloadSha256 = "0".repeat(64);
    if (field === "credential") value.credentialId = randomUUID();
    if (field === "actor") value.actor.deviceId = randomUUID();
    if (field === "epoch") value.epochs.wa++;
    f.enroll.mockResolvedValue(value);
    await expect(f.accept()).rejects.toThrow();
  });
  it("preserves the monotonic work deadline when wall time moves backwards", async () => {
    const f = fixture(), work = await f.accept();
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(work.signal.aborted).toBe(true); expect(() => work.assertLive()).toThrow();
  });
  it.each(["stop", "revocation", "engine"] as const)("keeps %s as an execution-ending event", async reason => {
    const f = fixture(), work = await f.accept();
    await vi.advanceTimersByTimeAsync(10_001);
    if (reason === "stop") f.stop.abort();
    if (reason === "revocation") f.revocation.abort();
    if (reason === "engine") f.engineLive.mockReturnValue(false);
    expect(() => work.assertLive()).toThrow();
    await work.close(); await work.close(); expect(f.close).toHaveBeenCalledOnce();
  });
  it("requires an exact closed revocation response; a foreign or malformed reply cannot kill work", async () => {
    const f = fixture(), work = await f.accept();
    f.check.mockResolvedValueOnce({ version: 1, acceptedWorkId: randomUUID(), state: "revoked" });
    await vi.advanceTimersByTimeAsync(30_000); work.assertLive();
    f.check.mockResolvedValueOnce({ version: 1, acceptedWorkId: f.receipt.acceptedWorkId, state: "revoked", extra: true });
    await vi.advanceTimersByTimeAsync(30_000); work.assertLive();
    f.check.mockResolvedValueOnce({ version: 1, acceptedWorkId: f.receipt.acceptedWorkId, state: "revoked" });
    await vi.advanceTimersByTimeAsync(30_000); expect(work.signal.aborted).toBe(true);
  });
  it("fails admission at ten seconds but retains and closes a delayed committed receipt", async () => {
    const f = fixture(), late = deferred<unknown>(); f.enroll.mockReturnValue(late.promise);
    const result = f.accept().catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: "cloud_admission_authority_timeout" });
    let disposed = false; const disposal = f.authority.dispose().then(() => { disposed = true; });
    await Promise.resolve(); expect(disposed).toBe(false); expect(f.close).not.toHaveBeenCalled();
    late.resolve(f.receipt); await disposal;
    expect(f.close).toHaveBeenCalledOnce(); expect(f.close.mock.calls[0]?.[0]).toMatchObject({
      acceptedWorkId: f.receipt.acceptedWorkId, claimId: f.request.claimId, commandId: f.request.command.commandId });
  });
  it("joins in-flight check I/O on Stop, never polls twice or reopens from its late current reply", async () => {
    const f = fixture(), late = deferred<unknown>(), work = await f.accept(); f.check.mockReturnValue(late.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    let closed = false; const closing = work.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.signal.aborted).toBe(true); expect(closed).toBe(false); expect(f.check).toHaveBeenCalledOnce();
    late.resolve({ version: 1, acceptedWorkId: f.receipt.acceptedWorkId, state: "current" }); await closing;
    expect(() => work.assertLive()).toThrow(); expect(f.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000); expect(f.check).toHaveBeenCalledOnce();
  });
  it("refuses an already aborted admission before transport", async () => {
    const f = fixture(); f.stop.abort();
    await expect(f.accept()).rejects.toThrow(); expect(f.enroll).not.toHaveBeenCalled();
  });
});
