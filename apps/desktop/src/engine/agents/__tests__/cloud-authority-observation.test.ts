import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentExecutionAdmission, CloudAgentExecutionRequest } from "@zeros/protocol/cloud-agent-execution";
import { CloudAgentLease } from "../cloud-agent-lease";

type Observer = {
  created(event: { flightId: string; operation: "validate" | "renew" | "refresh-codex" | "cache-publication"; producer: "caller" | "scheduled" }): void;
  wait(event: { waitId: string; flightId: string | null; consumer: "validate" | "refresh-codex" | "dispatch-ready"; phase: "waiting" | "unblocked" }): void;
  settled(event: { flightId: string; outcome: "settled" | "failed" }): void;
};
const leases: CloudAgentLease[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await Promise.allSettled(leases.splice(0).map(lease => lease.close())); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function fixture(observer?: Observer, codex = false) {
  const origin = Date.parse("2026-01-01T00:00:00Z"); let elapsed = 0;
  const time = { wall: () => origin + elapsed, monotonic: () => elapsed };
  const grant = { leaseId: randomUUID(), authorityId: "a".repeat(64), expiresAt: new Date(origin + 45_000).toISOString(), credentialVersion: 1,
    credentialKind: codex ? "codex-chatgpt" : "cursor-api-key", provider: codex ? "codex" : "cursor", model: "qualified-model",
    material: codex ? { kind: "codex-chatgpt", accessToken: "synthetic-initial-access-token", accountId: "synthetic-account", expiresAt: origin / 1000 + 3600 }
      : { kind: "cursor-api-key", apiKey: "synthetic-private-provider-key" } };
  const response = () => ({ leaseId: grant.leaseId, expiresAt: new Date(time.wall() + 45_000).toISOString(), credentialVersion: 1 });
  const request = vi.fn(async (input: CloudAgentExecutionRequest, _signal: AbortSignal, _observation?: { flightId: string }): Promise<unknown> =>
    input.kind === "admit" ? grant : input.kind === "release" ? { released: true } : response());
  const admission: CloudAgentExecutionAdmission = { executionId: randomUUID(), delegationId: randomUUID(), provider: codex ? "codex" : "cursor",
    model: "qualified-model", source: { kind: "session", actorSessionId: randomUUID() } };
  const lease = await CloudAgentLease.admit(admission, request, new AbortController().signal, { onRetirementFailure: vi.fn() }, time, observer);
  leases.push(lease); request.mockClear();
  return { lease, request, grant, response, advance: (ms: number) => { elapsed += ms; } };
}
function observer() { return { created: vi.fn<Observer["created"]>(), wait: vi.fn<Observer["wait"]>(), settled: vi.fn<Observer["settled"]>() }; }
function events<T>(mock: { mock: { calls: [T][] } }): T[] { return mock.mock.calls.map(([value]) => value); }

describe("passive cloud authority dependency observations", () => {
  it("keeps disabled requests at two arguments with unchanged authority JSON", async () => {
    const f = await fixture(); await f.lease.validate();
    expect(f.request).toHaveBeenCalledWith({ kind: "validate", leaseId: f.grant.leaseId, renew: false, credentialVersion: 1 }, f.lease.signal);
    expect(f.request.mock.calls[0]).toHaveLength(2); await f.lease.close(); expect(f.request.mock.calls.at(-1)).toHaveLength(2);
  });
  it("links an actual validation request to its flight and pairs the caller await", async () => {
    const o = observer(), f = await fixture(o); await f.lease.validate();
    expect(o.created).toHaveBeenCalledOnce();
    const flight = events(o.created)[0]!; expect(flight).toMatchObject({ operation: "validate", producer: "caller" });
    expect(flight.flightId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.request).toHaveBeenCalledWith({ kind: "validate", leaseId: f.grant.leaseId, renew: false, credentialVersion: 1 }, f.lease.signal, { flightId: flight.flightId });
    const waits = events(o.wait); expect(waits).toHaveLength(2);
    expect(waits[0]).toEqual({ waitId: expect.stringMatching(/^[0-9a-f-]{36}$/), flightId: flight.flightId, consumer: "validate", phase: "waiting" });
    expect(waits[1]).toEqual({ ...waits[0], phase: "unblocked" });
    expect(o.settled).toHaveBeenCalledWith({ flightId: flight.flightId, outcome: "settled" });
    expect(Object.keys(f.request.mock.calls[0]![0])).not.toContain("flightId");
  });
  it("retains a pre-existing scheduled renewal as a foreground validation dependency", async () => {
    const o = observer(), f = await fixture(o), held = deferred<unknown>();
    f.request.mockImplementationOnce(() => held.promise); f.advance(20_000); await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request).toHaveBeenCalledOnce();
    expect(o.created).toHaveBeenCalledWith(expect.objectContaining({ operation: "renew", producer: "scheduled" }));
    const scheduled = events(o.created)[0]!, waiting = f.lease.validate();
    expect(events(o.created)).toHaveLength(2);
    const caller = events(o.created)[1]!; expect(caller).toMatchObject({ operation: "validate", producer: "caller" });
    const predecessor = events(o.wait).filter(event => event.flightId === scheduled.flightId && event.phase === "waiting");
    expect(predecessor.length).toBeGreaterThanOrEqual(1); expect(f.request).toHaveBeenCalledOnce();
    held.resolve(f.response()); await waiting;
    expect(o.created).toHaveBeenCalledWith(scheduled); expect(o.created).toHaveBeenCalledTimes(2);
    for (const edge of predecessor) expect(o.wait).toHaveBeenCalledWith({ ...edge, phase: "unblocked" });
    expect(f.request.mock.calls[1]![2]).toEqual({ flightId: caller.flightId });
  });
  it("records separate waiter IDs for multiple callers sharing one renewal flight", async () => {
    const o = observer(), f = await fixture(o), held = deferred<unknown>();
    f.request.mockImplementationOnce(() => held.promise);
    const first = f.lease.validate(true), second = f.lease.validate(true), third = f.lease.validate(true);
    await Promise.resolve(); expect(f.request).toHaveBeenCalledOnce(); expect(o.created).toHaveBeenCalledOnce();
    const flight = events(o.created)[0]!, waits = events(o.wait).filter(event => event.phase === "waiting");
    expect(waits).toHaveLength(3); expect(new Set(waits.map(event => event.waitId)).size).toBe(3);
    expect(waits.every(event => event.flightId === flight.flightId && event.consumer === "validate")).toBe(true);
    held.resolve(f.response()); await Promise.all([first, second, third]);
    for (const edge of waits) expect(o.wait).toHaveBeenCalledWith({ ...edge, phase: "unblocked" });
    expect(o.settled).toHaveBeenCalledOnce();
  });
  it("captures the original validationTail predecessor rather than the next queued request", async () => {
    const o = observer(), f = await fixture(o), held = deferred<unknown>(); f.request.mockImplementationOnce(() => held.promise);
    const first = f.lease.validate(), second = f.lease.validate(); await Promise.resolve();
    const [a, b] = events(o.created); expect(a).toBeDefined(); expect(b).toBeDefined();
    const predecessor = events(o.wait).filter(event => event.flightId === a!.flightId && event.phase === "waiting");
    expect(predecessor).toHaveLength(2); expect(new Set(predecessor.map(event => event.waitId)).size).toBe(2);
    held.resolve(f.response()); await Promise.all([first, second]);
    expect(f.request.mock.calls.map(call => call[2])).toEqual([{ flightId: a!.flightId }, { flightId: b!.flightId }]);
  });
  it("pairs failed waits without changing the safe typed cause or measuring cleanup as a request flight", async () => {
    const o = observer(), f = await fixture(o); f.request.mockRejectedValueOnce(Object.assign(new Error("private synthetic detail"), { code: "cloud_validation_authority_http_5xx" }));
    await expect(f.lease.validate()).rejects.toMatchObject({ code: "cloud_validation_authority_http_5xx" });
    expect(o.settled).toHaveBeenCalledWith({ flightId: expect.any(String), outcome: "failed" });
    const waits = events(o.wait); expect(waits).toHaveLength(2); expect(waits[1]).toEqual({ ...waits[0], phase: "unblocked" });
    expect(f.request.mock.calls.at(-1)).toHaveLength(2); expect(o.created).toHaveBeenCalledOnce();
    expect(() => f.lease.assertLive()).toThrow(expect.objectContaining({ code: "cloud_validation_authority_http_5xx" }));
  });
  it("observes an awaited Codex refresh as a caller flight without relabelling it scheduled", async () => {
    const o = observer(), f = await fixture(o, true), material = { ...f.grant.material, accessToken: "synthetic-rotated-access-token" };
    f.request.mockResolvedValueOnce({ ...f.response(), credentialVersion: 2, rotation: { authorityId: f.grant.authorityId, material } });
    expect(await f.lease.refreshCodex(1, "synthetic-account")).toMatchObject({ credentialVersion: 2 });
    expect(o.created).toHaveBeenCalledWith({ flightId: expect.any(String), operation: "refresh-codex", producer: "caller" });
    expect(events(o.wait).every(event => event.consumer === "refresh-codex")).toBe(true);
    expect(f.request.mock.calls[0]![0]).toEqual({ kind: "refresh-codex", leaseId: f.grant.leaseId, credentialVersion: 1 });
    expect(f.request.mock.calls[0]![2]).toEqual({ flightId: events(o.created)[0]!.flightId });
  });
  it("contains observer exceptions without changing renewal results or deadlines", async () => {
    const fail = () => { throw new Error("synthetic observer failure"); }, f = await fixture({ created: fail, wait: fail, settled: fail });
    f.advance(5000); await f.lease.validate(true); f.advance(39_001); f.lease.assertLive();
    expect(f.request).toHaveBeenCalledOnce(); expect(f.request.mock.calls[0]![2]).toEqual({ flightId: expect.any(String) });
  });
  it("contains rejected async observer callbacks without awaiting or changing authority work", async () => {
    vi.useRealTimers(); const unhandled: unknown[] = [], capture = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", capture);
    const fail = async () => { throw new Error("synthetic observer rejection"); };
    const f = await fixture({ created: fail, wait: fail, settled: fail });
    try {
      await f.lease.validate(); f.lease.assertLive();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]); expect(f.request).toHaveBeenCalledOnce();
    } finally { process.off("unhandledRejection", capture); }
  });
  it("contains scheduled expiry rejection in the same promise path as an ordinary validation", async () => {
    const f = await fixture(); f.advance(44_001);
    await expect(vi.advanceTimersByTimeAsync(20_000)).resolves.toBe(vi);
    expect(f.request.mock.calls.some(([input]) => input.kind === "validate")).toBe(false);
    expect(f.lease.signal.aborted).toBe(true);
    expect(() => f.lease.assertLive()).toThrow(expect.objectContaining({ code: "cloud_validation_lease_expired" }));
  });
});
