import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSdkStreamCommand, CloudSdkStreamEvent, CloudSdkStreamSnapshot } from "../../../../shared/cloud-sdk-stream-contract";
import { CloudWorkspaceStreamController, CLOUD_STREAM_HIDDEN_RETENTION_MS } from "../cloud-workspace-stream-controller";
import type { CloudWorkspaceCatalogSnapshot } from "../../platform/cloud-workspaces";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const target = { organizationId: id(1), workspaceId: id(2) };
const snapshot = (revision = 1): CloudSdkStreamSnapshot => ({ streamId: id(3), leaseId: id(4), sequence: 0, revision,
  state: "open", catalogRequired: true, organizations: [{ organizationId: id(1), deviceStream: false, presence: false }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => vi.advanceTimersByTimeAsync(0);
const closes: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const close of closes.splice(0)) close(); vi.useRealTimers(); });
function fixture() {
  let account = 1, listener: (event: unknown) => void = () => {}, current = snapshot();
  const control = vi.fn(async (input: CloudSdkStreamCommand): Promise<unknown> => {
    if (input.action === "start") return current;
    if (input.action === "snapshot-current") {
      if (input.revision !== current.revision) return false;
      current = { ...current, sequence: current.sequence + 1, catalogRequired: false,
        organizations: [{ organizationId: id(1), deviceStream: true, presence: true }, { organizationId: id(8), deviceStream: false, presence: false }] };
      listener({ ...current, event: { type: "state" } }); return true;
    }
    return true;
  });
  const off = vi.fn(), listen = vi.fn(async (fn: (event: unknown) => void) => { listener = fn; return off; });
  const read = vi.fn(async (): Promise<CloudWorkspaceCatalogSnapshot> => ({ catalogVersion: 12, workspaces: [] })), apply = vi.fn(() => true), coverage = vi.fn();
  const controller = new CloudWorkspaceStreamController({ accountEpoch: () => account, control, listen, readSnapshot: read,
    applyCatalog: apply, onCoverage: coverage, onPayload: vi.fn() });
  closes.push(() => controller.dispose());
  const event = (patch: Partial<CloudSdkStreamSnapshot> = {}, payload: CloudSdkStreamEvent["event"] = { type: "state" }) => {
    current = { ...current, sequence: current.sequence + 1, ...patch }; listener({ ...current, event: payload });
  };
  return { controller, control, listen, read, apply, coverage, off, event, account: (next: number) => { account = next; } };
}

describe("renderer device stream lifetime", () => {
  it("does no native or SDK work for Local-only selections and shares one lease across cloud owner switches", async () => {
    const f = fixture(); f.controller.select(null, true); await tick();
    expect(f.listen).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    f.controller.select(target, true); await tick();
    f.controller.select({ organizationId: id(8), workspaceId: id(9) }, true); f.controller.select(target, true); await tick();
    expect(f.control.mock.calls.filter(([input]) => input.action === "start")).toHaveLength(1);
    expect(f.read).toHaveBeenCalledOnce();
    f.controller.select(null, true); await tick();
    expect(f.control).toHaveBeenLastCalledWith({ action: "stop", streamId: id(3), leaseId: id(4) });
  });

  it("keeps polls unproven until the current snapshot completes and suppresses only explicit organizations", async () => {
    const f = fixture(), read = deferred<{ catalogVersion: number; workspaces: [] }>(); f.read.mockReturnValueOnce(read.promise);
    f.controller.select(target, true); await tick();
    expect(f.coverage.mock.calls.at(-1)?.[0]).toBeNull();
    read.resolve({ catalogVersion: 12, workspaces: [] }); await tick();
    expect(f.coverage).toHaveBeenLastCalledWith(expect.objectContaining({ organizations: [
      { organizationId: id(1), deviceStream: true, presence: true }, { organizationId: id(8), deviceStream: false, presence: false },
    ] }));
    f.event({ state: "waiting", revision: 2, catalogRequired: false });
    expect(f.coverage).toHaveBeenLastCalledWith(null);
  });

  it("does not acknowledge a snapshot from before disconnect/reset and reads again for the new revision", async () => {
    const f = fixture(), read = deferred<{ catalogVersion: number; workspaces: [] }>(); f.read.mockReturnValueOnce(read.promise);
    f.controller.select(target, true); await tick(); f.event({ state: "waiting", revision: 2, catalogRequired: false });
    f.event({ state: "open", revision: 3, catalogRequired: true });
    read.resolve({ catalogVersion: 11, workspaces: [] }); await tick();
    const acknowledgements = f.control.mock.calls.map(([input]) => input).filter(input => input.action === "snapshot-current");
    expect(acknowledgements).toHaveLength(1); expect(acknowledgements[0]).toMatchObject({ revision: 3, catalogVersion: 12 });
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("fences a late start and late catalog event after an A1 to B to A2 account change", async () => {
    const f = fixture(), opening = deferred<unknown>(); f.control.mockReturnValueOnce(opening.promise);
    f.controller.select(target, true); await tick(); f.account(3); f.controller.select(null, true);
    opening.resolve(snapshot()); await tick();
    expect(f.control).toHaveBeenLastCalledWith({ action: "stop", streamId: id(3), leaseId: id(4) });
    f.event({}, { type: "frame", frame: { t: "catalog.changed", c: "old", d: { workspaceId: target.workspaceId, version: 7, catalogVersion: 12, op: "remove" } } });
    expect(f.apply).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.off).toHaveBeenCalledOnce();
  });

  it("clears coverage on hide and retires the hidden stream at its bounded deadline", async () => {
    const f = fixture(); f.controller.select(target, true); await tick(); f.controller.select(target, false);
    expect(f.coverage).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(CLOUD_STREAM_HIDDEN_RETENTION_MS - 1);
    expect(f.control.mock.calls.some(([input]) => input.action === "stop")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.control).toHaveBeenLastCalledWith({ action: "stop", streamId: id(3), leaseId: id(4) });
    expect(f.off).toHaveBeenCalledOnce();
  });

  it("takes another complete snapshot when native event sequence skips a payload", async () => {
    const f = fixture(); f.controller.select(target, true); await tick();
    f.event({ sequence: 6 }); await tick();
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("retries stopped discovery on a different cloud selection without repeatedly probing the same key", async () => {
    const f = fixture(); f.controller.select(target, true); await tick();
    f.event({ state: "stopped", revision: 2, catalogRequired: false });
    f.controller.select(target, true); await tick();
    expect(f.control.mock.calls.filter(([input]) => input.action === "start")).toHaveLength(1);
    f.controller.select({ organizationId: id(8), workspaceId: id(9) }, true); await tick();
    expect(f.control.mock.calls.filter(([input]) => input.action === "start")).toHaveLength(2);
  });

  it("does not spin snapshot reads or prove coverage when the server omits its watermark", async () => {
    const f = fixture(); f.read.mockResolvedValue({ catalogVersion: null, workspaces: [] });
    f.controller.select(target, true); await tick(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.read).toHaveBeenCalledOnce(); expect(f.coverage).toHaveBeenLastCalledWith(null);
  });

  it("pauses catch-up while hidden and resumes on reveal before the retention deadline", async () => {
    const f = fixture(); f.controller.select(target, true); await tick(); f.controller.select(target, false);
    f.event({ revision: 3, catalogRequired: true }); await tick();
    expect(f.read).toHaveBeenCalledOnce();
    f.controller.select(target, true); await tick(); await vi.advanceTimersByTimeAsync(CLOUD_STREAM_HIDDEN_RETENTION_MS);
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.control.mock.calls.some(([input]) => input.action === "stop")).toBe(false);
  });

  it("backs off a failed snapshot and cancels that retry when Local becomes selected", async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new Error("offline"));
    f.controller.select(target, true); await tick();
    expect(f.read).toHaveBeenCalledOnce(); expect(f.coverage).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(999); expect(f.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(f.read).toHaveBeenCalledTimes(2);
    f.read.mockRejectedValueOnce(new Error("offline")); f.event({ revision: 4, catalogRequired: true }); await tick();
    f.controller.select(null, true); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.read).toHaveBeenCalledTimes(3);
  });
});
