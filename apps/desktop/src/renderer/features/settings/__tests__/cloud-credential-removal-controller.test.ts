import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudCredentialRemovalController, type CloudCredentialRemovalIo } from "../cloud-credential-removal-controller";
import { persistCloudCredentialRemovalIntent, findCloudCredentialRemovalIntent } from "../cloud-credential-removal-store";
import { beginCloudCredentialRemoval, acceptCloudCredentialRemovalOutcome, decideCloudCredentialRemovalState } from "../cloud-credential-removal";
const userId = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const credentialId = "33333333-3333-4333-8333-333333333333", operationId = "44444444-4444-4444-8444-444444444444", requestId = "55555555-5555-4555-8555-555555555555";
const target = { kind: "remove-organization-credential" as const, organizationId, credentialId, expectedCredentialRevision: 2 };
const waiting = { version: 1 as const, operationId, revision: 1, state: "awaiting-confirmation" as const, confirmedRunning: true as const, expiresAt: "2099-10-08T00:00:00Z" };
const removed = { version: 1 as const, operationId, revision: 2, state: "removed" as const };
const pending = { version: 1 as const, operationId, revision: 1, state: "pending" as const, phase: "preparing" as const, retryAfterMs: 100 };
beforeEach(() => { const saved = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  let current = true;
  const io = { prepare: vi.fn<CloudCredentialRemovalIo["prepare"]>(async () => waiting),
    read: vi.fn<CloudCredentialRemovalIo["read"]>(async () => removed), decide: vi.fn<CloudCredentialRemovalIo["decide"]>(async () => removed) };
  const uuid = vi.fn().mockReturnValueOnce(operationId).mockReturnValue(requestId), completed = vi.fn();
  const controller = createCloudCredentialRemovalController({ userId, isCurrent: () => current, io, uuid, onRemoved: completed });
  return { controller, io, completed, leaveAccount: () => { current = false; } };
}
describe("durable Settings removal controller", () => {
  it("persists exact owner/target before prepare and waits for authoritative running proof", async () => {
    const f = setup(); f.io.prepare.mockImplementation(async () => {
      expect(findCloudCredentialRemovalIntent(userId, target)?.operationId).toBe(operationId); return waiting;
    });
    await f.controller.start(target);
    expect(f.controller.snapshot().state?.outcome).toEqual(waiting); expect(f.io.decide).not.toHaveBeenCalled(); expect(f.completed).not.toHaveBeenCalled();
  });
  it("removes an authoritatively idle target without a running confirmation", async () => {
    const f = setup(); f.io.prepare.mockResolvedValueOnce(removed);
    await f.controller.start(target); expect(f.controller.snapshot().state?.outcome?.state).toBe("removed");
    expect(f.completed).toHaveBeenCalledOnce(); expect(f.io.decide).not.toHaveBeenCalled();
  });
  it("persists Yes before submission and never cancels it on unmount or unknown ACK", async () => {
    const f = setup(); await f.controller.start(target);
    f.io.decide.mockImplementation(async () => {
      expect(findCloudCredentialRemovalIntent(userId, target)?.decision).toEqual({ action: "confirm", requestId, expectedRevision: 1 });
      throw new Error("Synthetic unknown ACK");
    });
    await f.controller.decide("confirm"); await f.controller.detach();
    expect(f.io.decide.mock.calls.map(call => call[1])).toEqual(["confirm"]);
    expect(findCloudCredentialRemovalIntent(userId, target)?.decision?.requestId).toBe(requestId);
  });
  it("replays the same durable Yes request after remount without a fresh mutation identity", async () => {
    let state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(operationId, target), waiting);
    state = decideCloudCredentialRemovalState(state, "confirm", requestId); persistCloudCredentialRemovalIntent(userId, state);
    const f = setup(); await f.controller.start(target);
    expect(f.io.decide).toHaveBeenCalledExactlyOnceWith(operationId, "confirm", { requestId, expectedRevision: 1 });
    expect(f.io.prepare).not.toHaveBeenCalled(); expect(f.completed).toHaveBeenCalledOnce();
  });
  it("unmount cancellation uses the exact issued revision and does not remove the source", async () => {
    const f = setup(); f.io.decide.mockResolvedValueOnce({ ...removed, state: "cancelled" });
    await f.controller.start(target); await f.controller.detach();
    expect(f.io.decide).toHaveBeenCalledExactlyOnceWith(operationId, "cancel", { requestId, expectedRevision: 1 });
    expect(f.completed).not.toHaveBeenCalled();
  });
  it("does not deliver a late account-A outcome or issue a decision under account B", async () => {
    const f = setup(); let resolve!: (value: typeof waiting) => void;
    f.io.prepare.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const started = f.controller.start(target); f.leaveAccount(); resolve(waiting); await started;
    await f.controller.decide("confirm"); await f.controller.detach();
    expect(f.controller.snapshot().state?.outcome).toBeUndefined(); expect(f.io.decide).not.toHaveBeenCalled(); expect(f.completed).not.toHaveBeenCalled();
  });
  it("keeps unknown activity pending and retries only the same operation", async () => {
    vi.useFakeTimers(); const f = setup(); f.io.prepare.mockResolvedValueOnce(pending); f.io.read.mockResolvedValueOnce({ ...waiting, revision: 2 });
    await f.controller.start(target); expect(f.controller.snapshot().state?.outcome).toEqual(pending);
    expect(f.io.decide).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(101);
    expect(f.io.read).toHaveBeenCalledExactlyOnceWith(operationId); expect(f.controller.snapshot().state?.outcome).toEqual({ ...waiting, revision: 2 });
    await f.controller.detach();
  });
  it("refuses unreadable durable prior intents before any new request", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("Synthetic unavailable storage"); } });
    const f = setup(); await expect(f.controller.start(target)).rejects.toThrow("Saved cloud removal state is unavailable");
    expect(f.io.prepare).not.toHaveBeenCalled(); expect(f.io.decide).not.toHaveBeenCalled();
  });
  it("serializes duplicate clicks and refuses a different target until this operation settles", async () => {
    const f = setup(); let resolve!: (value: typeof waiting) => void;
    f.io.prepare.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = f.controller.start(target), second = f.controller.start(target);
    await expect(f.controller.start({ ...target, expectedCredentialRevision: 3 })).rejects.toThrow();
    resolve(waiting); await Promise.all([first, second]); expect(f.io.prepare).toHaveBeenCalledOnce(); await f.controller.detach();
  });
  it("can retry the same durable operation after a synchronous boundary refusal", async () => {
    const f = setup(); f.io.prepare.mockImplementationOnce(() => { throw new Error("Synthetic closed request boundary"); });
    await f.controller.start(target); await f.controller.retry();
    expect(f.io.prepare).toHaveBeenCalledTimes(2);
    expect(f.io.prepare.mock.calls.map(call => call[0])).toEqual([operationId, operationId]);
    expect(f.controller.snapshot().state?.outcome).toEqual(waiting);
    await f.controller.detach();
  });
});
