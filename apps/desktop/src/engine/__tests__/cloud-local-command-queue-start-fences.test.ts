import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCredentialStartFences, CloudAgentCredentialControlRequestSchema, CloudAgentCredentialControlAcknowledgementSchema,
  CloudAgentCredentialControlExchangeRequestSchema, CloudAgentCredentialControlExchangeResponseSchema,
  type CloudAgentCredentialControlRequest } from "../cloud-local-command-queue-start-fences";
import * as cp from "../../../../control-plane/src/cloud-workspaces/agent-credential-mutations";
import type { CloudAgentCredentialRunInfo, CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { openSqlite } from "../db/sqlite";

const scope: CloudAgentBootScope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2,
  engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const run: CloudAgentCredentialRunInfo = { version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch, cacheRevision: 1,
  provider: "claude", fundingOwnerUserId: scope.fundingOwnerUserId, fundingOwnerEpoch: 1, credentialId: randomUUID(),
  credentialRevision: 1, connectionRevision: 1, adoptionId: randomUUID(), materialVersion: 1, displayName: "Synthetic fixture account" };
const selector = { provider: run.provider, credentialId: run.credentialId };
const directories: string[] = [], handles: CloudCredentialStartFences[] = [];
function fixture(file = path.join(mkdtempSync(path.join(tmpdir(), "zeros-start-fences-")), "queue.sqlite"),
  associationFloor?: ConstructorParameters<typeof CloudCredentialStartFences>[0]["associationFloor"]) {
  if (!directories.includes(path.dirname(file))) directories.push(path.dirname(file));
  let ready = 1, desired = 1;
  let inventory: { complete: boolean; foreground: number; reservedLaunches: number; background: number; idleHosts: number;
    scopes: { executionId: string; conversationId: string; commandId: string | null; phase: "foreground" | "background" | "idle" | "launch-reserved";
      credentialRun: CloudAgentCredentialRunInfo }[] } = { complete: true, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] };
  const activity = vi.fn(() => inventory), retire = vi.fn(async () => {}), synchronize = vi.fn(async () => { ready = desired; });
  const fences = new CloudCredentialStartFences({ file, scope, engineLive: () => true, activity, retire,
    markDesired: (revision: number) => { desired = Math.max(desired, revision); }, readyRevision: () => ready, synchronize,
    ...(associationFloor ? { associationFloor } : {}) });
  handles.push(fences);
  const request = (operation: CloudAgentCredentialControlRequest["operation"] = "pause-starts",
    overrides: Partial<CloudAgentCredentialControlRequest> = {}): CloudAgentCredentialControlRequest => ({ ...scope,
      version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(), fenceEpoch: 1, selectors: [selector], operation,
      desiredCacheRevision: operation === "publish-desired" ? 2 : null, ...overrides });
  return { file, fences, request, activity, retire, synchronize,
    setInventory: (value: typeof inventory) => { inventory = value; }, setReady: (value: number) => { ready = value; } };
}
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("durable engine credential start fences", () => {
  it("permits only a positively retired, newer CP association after both durable source floors", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-association-floors-")), file = path.join(directory,"queue.sqlite");
    const floor = vi.fn(() => ({ cacheRevision: 3, connectionRevision: 2 }));
    const f = fixture(file,floor), pause = f.request(); f.setReady(3); await f.fences.handle(pause);
    f.retire.mockImplementationOnce(async () => {
      const db = openSqlite(file,{ readonly: true });
      try { expect(db.prepare("SELECT cache_revision,connection_revision FROM local_credential_retirement_floors").get())
        .toEqual({ cache_revision: 3, connection_revision: 2 }); } finally { db.close(); }
    });
    expect(await f.fences.handle({ ...pause,controlRequestId: randomUUID(),operation: "retire" })).toMatchObject({ phase: "retired" });
    f.setReady(4);
    for (const next of [{ cacheRevision: 3, connectionRevision: 3 }, { cacheRevision: 4, connectionRevision: 2 }])
      expect(f.fences.canStart({ ...run,...next })).toBe(false);
    expect(f.fences.canStart({ ...run,cacheRevision: 4,connectionRevision: 3 })).toBe(true);
    f.fences.close(); const restored = fixture(file,() => ({ cacheRevision: 100,connectionRevision: 100 })); restored.setReady(4);
    expect(restored.fences.canStart({ ...run,cacheRevision: 4,connectionRevision: 3 })).toBe(true);
    const overlapping = restored.request(); await restored.fences.handle(overlapping);
    expect(restored.fences.canStart({ ...run,cacheRevision: 4,connectionRevision: 3 })).toBe(false);
  });
  it("mirrors exact private CP request/ACK and exchange shapes without trusting a renderer selector", async () => {
    const f = fixture(), request = f.request(), ack = await f.fences.handle(request);
    expect(CloudAgentCredentialControlRequestSchema.parse(request)).toEqual(cp.CloudAgentCredentialControlRequestSchema.parse(request));
    expect(CloudAgentCredentialControlAcknowledgementSchema.parse(ack)).toEqual(cp.CloudAgentCredentialControlAcknowledgementSchema.parse(ack));
    const exchange = { version: 1, mode: "boot-owner-v1", ...scope, acknowledgements: [ack] };
    const { fundingOwnerUserId: _user, fundingOwnerEpoch: _epoch, ...wire } = exchange;
    expect(CloudAgentCredentialControlExchangeRequestSchema.parse(wire)).toEqual(cp.CloudAgentCredentialControlExchangeRequestSchema.parse(wire));
    const response = { version: 1, mode: "boot-owner-v1", controls: [request] };
    expect(CloudAgentCredentialControlExchangeResponseSchema.parse(response)).toEqual(cp.CloudAgentCredentialControlExchangeResponseSchema.parse(response));
    for (const bad of [{ ...request, desiredCacheRevision: 2 }, { ...request, selectors: [selector, selector] }, { ...request, actor: {} }]) {
      expect(CloudAgentCredentialControlRequestSchema.safeParse(bad).success).toBe(false);
      expect(cp.CloudAgentCredentialControlRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("commits the start fence before any activity observation and covers all old native captures", async () => {
    const f = fixture(), phases = ["foreground", "launch-reserved", "background", "idle"] as const;
    const inventory = { complete: true, foreground: 1, reservedLaunches: 1, background: 1, idleHosts: 1,
      scopes: phases.map(phase => ({ executionId: randomUUID(), conversationId: randomUUID(), commandId: null, phase, credentialRun: run })) };
    f.setInventory(inventory);
    f.activity.mockImplementationOnce(() => {
      expect(f.fences.canStart(run)).toBe(false);
      const db = openSqlite(f.file, { readonly: true });
      try { expect(db.prepare("SELECT phase FROM local_credential_start_fences").get()).toEqual({ phase: "fenced" }); }
      finally { db.close(); }
      return inventory;
    });
    const ack = await f.fences.handle(f.request());
    expect(ack.startsFenced).toBe(true);
    expect(ack.activity).toEqual(inventory);
    expect(f.fences.canStart({ ...run, credentialRevision: 100, materialVersion: 100 })).toBe(false);
    expect(f.fences.canStart({ ...run, credentialId: randomUUID() })).toBe(true);
  });
  it("reconciles a lost ACK from durable exact body identity and refuses conflicting or foreign scope", async () => {
    const f = fixture(), request = f.request(), ack = await f.fences.handle(request); f.fences.close();
    const recovered = fixture(f.file);
    expect(await recovered.fences.handle(request)).toEqual(ack);
    await expect(recovered.fences.handle({ ...request, selectors: [{ ...selector, credentialId: randomUUID() }] })).rejects.toThrow("credential_control_conflict");
    await expect(recovered.fences.handle({ ...request, controlRequestId: randomUUID(), writerEpoch: randomUUID() })).rejects.toThrow("credential_control_authority_rejected");
    expect(recovered.fences.canStart(run)).toBe(false);
  });
  it("uses a release-before-pause tombstone and never lets one release remove another mutation's fence", async () => {
    const f = fixture(), first = f.request(), second = f.request();
    await f.fences.handle({ ...first, operation: "release" });
    expect(await f.fences.handle({ ...first, controlRequestId: randomUUID() })).toMatchObject({ phase: "released", mutationFenced: false });
    await f.fences.handle(second);
    await f.fences.handle({ ...first, controlRequestId: randomUUID(), operation: "release" });
    expect(f.fences.canStart(run)).toBe(false);
    await f.fences.handle({ ...second, controlRequestId: randomUUID(), operation: "release" });
    expect(f.fences.canStart(run)).toBe(true);
  });
  it("parks unsubmitted work until the background publication is ready, without a Send-time request", async () => {
    const f = fixture(), pause = f.request(); await f.fences.handle(pause);
    let release!: () => void;
    f.synchronize.mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
    const publication = f.fences.handle({ ...pause, controlRequestId: randomUUID(), operation: "publish-desired", desiredCacheRevision: 2 });
    await Promise.resolve(); expect(f.fences.canStart(run)).toBe(false); expect(f.synchronize).toHaveBeenCalledOnce();
    f.setReady(2); release();
    expect(await publication).toMatchObject({ phase: "ready", desiredCacheRevision: 2, readyCacheRevision: 2, mutationFenced: false });
    expect(f.fences.canStart(run)).toBe(false);
    expect(f.fences.canStart({ ...run, cacheRevision: 2 })).toBe(true);
    expect(f.synchronize).toHaveBeenCalledOnce();
    await expect(f.fences.handle({ ...pause, controlRequestId: randomUUID(), operation: "release" })).rejects.toThrow("credential_control_conflict");
  });
  it("requires a fenced exact mutation before publishing desired credentials", async () => {
    const f = fixture();
    await expect(f.fences.handle(f.request("publish-desired"))).rejects.toThrow("credential_control_conflict");
    expect(f.synchronize).not.toHaveBeenCalled();
  });
  it("persists irreversible retirement before awaiting positive whole-scope proof", async () => {
    const f = fixture(), request = f.request(); await f.fences.handle(request);
    let release!: () => void;
    f.retire.mockImplementationOnce(async () => {
      expect(f.fences.canStart(run)).toBe(false);
      await new Promise<void>(done => { release = done; });
    });
    const retiring = f.fences.handle({ ...request, controlRequestId: randomUUID(), operation: "retire" });
    await Promise.resolve();
    await expect(f.fences.handle({ ...request, controlRequestId: randomUUID(), operation: "release" })).rejects.toThrow("credential_control_conflict");
    release(); expect(await retiring).toMatchObject({ phase: "retired", startsFenced: true, activity: { complete: true, scopes: [] }, proofId: expect.any(String) });
    expect(f.fences.canStart({ ...run, cacheRevision: 100 })).toBe(false);
  });
  it.each(["failure", "unknown", "late-background"])("does not claim all stopped after %s retirement", async kind => {
    const f = fixture(), request = f.request(); await f.fences.handle(request);
    if (kind === "failure") f.retire.mockRejectedValueOnce(new Error("Synthetic native proof failure"));
    else f.setInventory({ complete: kind !== "unknown", foreground: 0, reservedLaunches: 0, background: kind === "late-background" ? 1 : 0, idleHosts: 0,
      scopes: kind === "late-background" ? [{ executionId: randomUUID(), conversationId: randomUUID(), commandId: null, phase: "background", credentialRun: run }] : [] });
    expect(await f.fences.handle({ ...request, controlRequestId: randomUUID(), operation: "retire" })).toMatchObject({ phase: "failed", startsFenced: true, proofId: null });
    expect(f.fences.canStart(run)).toBe(false);
  });
  it("refuses contradictory complete counters and foreign captured provenance as unknown inventory", async () => {
    const f = fixture(); f.setInventory({ complete: true, foreground: 1, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] });
    expect(await f.fences.handle(f.request())).toMatchObject({ activity: { complete: false } });
    f.setInventory({ complete: true, foreground: 1, reservedLaunches: 0, background: 0, idleHosts: 0,
      scopes: [{ executionId: randomUUID(), conversationId: randomUUID(), commandId: null, phase: "foreground", credentialRun: { ...run, writerEpoch: randomUUID() } }] });
    expect(await f.fences.handle(f.request())).toMatchObject({ activity: { complete: false } });
  });
  it("bounds durable control receipts and refuses new work before changing any start eligibility", async () => {
    const f = fixture(); await f.fences.handle(f.request());
    const db = openSqlite(f.file, { readonly: true });
    try { expect(db.pragma("journal_mode", { simple: true })).toBe("wal"); }
    finally { db.close(); }
    f.fences.close();
    const bounded = new CloudCredentialStartFences({ file: f.file, scope, maxOperations: 1, engineLive: () => true,
      activity: f.activity, retire: f.retire, markDesired: vi.fn(), readyRevision: () => 1, synchronize: f.synchronize }); handles.push(bounded);
    await expect(bounded.handle(f.request())).rejects.toThrow("credential_control_limit");
  });
  it("retains a recorded ACK for background delivery until the exact private exchange confirms it", async () => {
    const f = fixture(), request = f.request(), ack = await f.fences.handle(request);
    expect(f.fences.pendingAcknowledgement()).toEqual(ack);
    f.fences.close(); const recovered = fixture(f.file);
    expect(recovered.fences.pendingAcknowledgement()).toEqual(ack);
    expect(() => recovered.fences.confirmAcknowledgement({ ...ack, controlRevision: ack.controlRevision + 1 })).toThrow("credential_control_conflict");
    recovered.fences.confirmAcknowledgement(ack);
    expect(recovered.fences.pendingAcknowledgement()).toBeNull();
    expect(await recovered.fences.handle(request)).toEqual(ack);
  });
  it("keeps ready/released/retired tombstones and does not reactivate inherited control under a foreign writer", async () => {
    const f = fixture(); await f.fences.handle(f.request()); f.fences.close();
    expect(() => new CloudCredentialStartFences({ file: f.file, scope: { ...scope, writerEpoch: randomUUID() }, engineLive: () => true,
      activity: f.activity, retire: f.retire, markDesired: vi.fn(), readyRevision: () => 1, synchronize: f.synchronize })).toThrow("credential_control_authority_rejected");
  });
  it("reserves monotonic removal capacity when ordinary control receipts are full", async () => {
    const f = fixture(), request = f.request(); await f.fences.handle(request); f.fences.close();
    const bounded = new CloudCredentialStartFences({ file: f.file, scope, maxOperations: 1, engineLive: () => true,
      activity: f.activity, retire: f.retire, markDesired: vi.fn(), readyRevision: () => 1, synchronize: f.synchronize }); handles.push(bounded);
    expect(await bounded.handle({ ...request, controlRequestId: randomUUID(), operation: "retire" })).toMatchObject({ phase: "retired", proofId: expect.any(String) });
  });
});
