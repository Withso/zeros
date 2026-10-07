import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudWorkspacePortForwarding } from "../cloud-workspace-port-forwarding";
import { CloudPortForwardingPreferences } from "../cloud-workspace-port-forwarding-store";
import type { CloudServiceReceipt } from "../cloud-workspace-access-broker";
import type { CloudDetectedPorts } from "../cloud-workspace-detected-ports";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const context = { authorityId: "33333333-3333-4333-8333-333333333333", deviceId: "44444444-4444-4444-8444-444444444444", keyVersion: 1 };
const runtime = { ...target, runtimeId: "55555555-5555-4555-8555-555555555555", generation: 1, authorityEpoch: 1, engineInstanceId: "66666666-6666-4666-8666-666666666666", connectionSequence: 1 };
const roots: string[] = [], coordinators: CloudWorkspacePortForwarding[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-auto-forward-")); roots.push(root);
  const preferences = new CloudPortForwardingPreferences(path.join(root, "preferences.json"));
  let currentRuntime = { ...runtime }, currentContext = { ...context };
  const now = Date.now(), timestamp = new Date(now).toISOString(), rows: CloudServiceReceipt[] = [];
  const snapshot = (ports: number[] | null): CloudDetectedPorts => ({ ...target, generation: currentRuntime.generation, version: 1, status: "ready", observedAt: ports === null ? null : timestamp,
    ports: ports?.map(port => ({ port, protocol: "tcp", health: "observed", processLabel: null, observedAt: timestamp, closedAt: null })) ?? null });
  const broker = {
    serviceContext: vi.fn(() => currentContext),
    assertRuntime: vi.fn((input: typeof runtime) => { for (const field of Object.keys(currentRuntime) as Array<keyof typeof runtime>) if (input[field] !== currentRuntime[field]) throw new Error("Runtime superseded"); }),
    listServices: vi.fn((input: typeof target & typeof context) => {
      if (input.authorityId !== currentContext.authorityId || input.deviceId !== currentContext.deviceId || input.keyVersion !== currentContext.keyVersion) throw new Error("Device authority changed");
      return [...rows];
    }),
    startAutomaticTunnel: vi.fn(async (input: typeof runtime & typeof context & { localPort: number; remotePort: number }) => {
      const receipt = { accessId: randomUUID(), expiresAt: new Date(now + 15 * 60000).toISOString(), localHost: "127.0.0.1" as const, localPort: input.localPort, remotePort: input.remotePort };
      rows.push({ ...receipt, kind: "tunnel", generation: input.generation, closing: false, ownership: "auto" });
      return receipt;
    }),
    revoke: vi.fn(async (id: string) => { const index = rows.findIndex(row => row.accessId === id); if (index >= 0) rows.splice(index, 1); return true; }),
  };
  const readPorts = vi.fn(async () => snapshot([3000]));
  const coordinator = new CloudWorkspacePortForwarding({ broker, preferences, accountId: "account-a", readPorts, now: () => now });
  coordinators.push(coordinator);
  return { coordinator, broker, preferences, readPorts, rows, snapshot, replaceRuntime: (next: typeof runtime) => { currentRuntime = next; }, rotateDevice: () => { currentContext = { ...context, keyVersion: 2 }; } };
}
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map(coordinator => coordinator.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("native cloud automatic forwarding", () => {
  it("does no background work until forwarding is enabled and an exact runtime is connected", async () => {
    const f = await fixture();
    expect(f.coordinator.readPreferences({ ...target, ...context })).toEqual({ forwardingEnabled: false, autoForwardEnabled: true });
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    await f.coordinator.refresh();
    expect(f.readPorts).not.toHaveBeenCalled();
    f.coordinator.publishRuntime({ ...runtime, connected: true });
    await f.coordinator.refresh();
    expect(f.broker.startAutomaticTunnel).toHaveBeenCalledWith({ ...runtime, ...context, localPort: 3000, remotePort: 3000 });
    expect(f.readPorts).toHaveBeenCalledTimes(1);
  });
  it("uses the next local port on a bind collision and publishes the actual forwarded destination", async () => {
    const f = await fixture();
    f.broker.startAutomaticTunnel.mockRejectedValueOnce(Object.assign(new Error("Port occupied"), { code: "local_port_in_use" }));
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true });
    await f.coordinator.refresh();
    expect(f.rows[0]?.localPort).toBe(3001);
    expect(f.broker.startAutomaticTunnel).toHaveBeenCalledTimes(2);
  });
  it("retains automatic forwards through unknown reads, removes disappeared ports and never revokes manual siblings", async () => {
    const f = await fixture(), manualId = randomUUID();
    f.rows.push({ accessId: manualId, kind: "tunnel", generation: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), localPort: 4173, remotePort: 4173, closing: false });
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true });
    await f.coordinator.refresh();
    const automaticId = f.rows.find(row => row.ownership === "auto")!.accessId;
    f.readPorts.mockResolvedValueOnce(f.snapshot(null));
    await f.coordinator.refresh();
    expect(f.broker.revoke).not.toHaveBeenCalled();
    f.readPorts.mockResolvedValueOnce(f.snapshot([]));
    await f.coordinator.refresh();
    expect(f.broker.revoke).toHaveBeenCalledWith(automaticId);
    expect(f.rows.map(row => row.accessId)).toEqual([manualId]);
  });
  it("keeps forwarding a detected listener when its application health changes", async () => {
    const f = await fixture();
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true }); await f.coordinator.refresh();
    const snapshot = f.snapshot([3000]); snapshot.ports![0]!.health = "unhealthy";
    f.readPorts.mockResolvedValueOnce(snapshot); await f.coordinator.refresh();
    expect(f.broker.revoke).not.toHaveBeenCalled();
    expect(f.rows).toHaveLength(1);
  });
  it.each(["forwardingEnabled", "autoForwardEnabled"] as const)("retires only automatic grants immediately when %s turns off", async field => {
    const f = await fixture();
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true });
    await f.coordinator.refresh();
    f.coordinator.setPreferences({ ...target, ...context }, { [field]: false });
    await f.coordinator.refresh();
    expect(f.rows).toEqual([]);
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
    expect(f.readPorts).toHaveBeenCalledTimes(1);
  });
  it("aborts detection and rejects its late result after disconnect without waking or granting", async () => {
    const f = await fixture();
    let release!: (value: CloudDetectedPorts) => void;
    f.readPorts.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true });
    const pending = f.coordinator.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.coordinator.publishRuntime({ ...runtime, connected: false });
    release(f.snapshot([3000]));
    await pending;
    expect(f.broker.startAutomaticTunnel).not.toHaveBeenCalled();
  });
  it("revokes a late tunnel after opt-out and does not revive it", async () => {
    const f = await fixture(), start = f.broker.startAutomaticTunnel.getMockImplementation()!;
    let release!: () => void;
    f.broker.startAutomaticTunnel.mockImplementationOnce(async input => { await new Promise<void>(resolve => { release = resolve; }); return start(input); });
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true });
    const pending = f.coordinator.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: false });
    release(); await pending;
    expect(f.rows).toEqual([]);
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
  });
  it("resumes forwarding after rapid opt-out and opt-in while an older detection read is pending", async () => {
    const f = await fixture();
    let release!: (value: CloudDetectedPorts) => void;
    f.readPorts.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true });
    const pending = f.coordinator.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: false });
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    release(f.snapshot([4173])); await pending;
    await vi.waitFor(() => expect(f.rows.map(row => row.remotePort)).toEqual([3000]));
    expect(f.readPorts).toHaveBeenCalledTimes(2);
  });
  it("does not silently reissue a revoked automatic service and stops passive reads", async () => {
    const f = await fixture();
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true }); await f.coordinator.refresh();
    f.rows.splice(0);
    await f.coordinator.refresh(); await f.coordinator.refresh();
    expect(f.broker.startAutomaticTunnel).toHaveBeenCalledTimes(1);
    expect(f.readPorts).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 404, 409])("withdraws automatic forwards and stops reads after authority refusal %s", async status => {
    const f = await fixture();
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true }); await f.coordinator.refresh();
    f.readPorts.mockRejectedValueOnce(Object.assign(new Error("Authority ended"), { status }));
    await f.coordinator.refresh(); await f.coordinator.refresh();
    expect(f.rows).toEqual([]);
    expect(f.readPorts).toHaveBeenCalledTimes(2);
  });
  it("retires only the old automatic runtime on exact generation replacement", async () => {
    const f = await fixture();
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true }); await f.coordinator.refresh();
    const previousId = f.rows[0]!.accessId, next = { ...runtime, runtimeId: randomUUID(), generation: 2, engineInstanceId: randomUUID(), connectionSequence: 1 };
    f.replaceRuntime(next); f.coordinator.publishRuntime({ ...next, connected: true }); await f.coordinator.refresh();
    expect(f.broker.revoke).toHaveBeenCalledWith(previousId);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.generation).toBe(2);
    expect(f.broker.startAutomaticTunnel).toHaveBeenLastCalledWith({ ...next, ...context, localPort: 3000, remotePort: 3000 });
  });
  it("does not reopen a manually stopped automatic port until detection disappears", async () => {
    const f = await fixture();
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true }); await f.coordinator.refresh();
    await f.coordinator.revoke(f.rows[0]!.accessId); await f.coordinator.refresh();
    expect(f.broker.startAutomaticTunnel).toHaveBeenCalledTimes(1);
    f.readPorts.mockResolvedValueOnce(f.snapshot([])); await f.coordinator.refresh();
    await f.coordinator.refresh();
    expect(f.broker.startAutomaticTunnel).toHaveBeenCalledTimes(2);
  });
  it("fails closed after device rotation or a non-running generation snapshot", async () => {
    const f = await fixture();
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true }); await f.coordinator.refresh();
    f.rotateDevice(); await f.coordinator.refresh();
    expect(f.rows).toEqual([]);
    expect(f.readPorts).toHaveBeenCalledTimes(1);
    const other = await fixture();
    other.readPorts.mockResolvedValueOnce({ ...other.snapshot([3000]), status: "stopped" });
    other.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    other.coordinator.publishRuntime({ ...runtime, connected: true }); await other.coordinator.refresh();
    expect(other.broker.startAutomaticTunnel).not.toHaveBeenCalled();
  });
  it("does not forward a port already covered by a manual tunnel", async () => {
    const f = await fixture();
    f.rows.push({ accessId: randomUUID(), kind: "tunnel", generation: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), localPort: 3001, remotePort: 3000, closing: false });
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true }); await f.coordinator.refresh();
    expect(f.broker.startAutomaticTunnel).not.toHaveBeenCalled();
  });
  it("prunes workspace intent and disposes all automatic work while preserving account isolation", async () => {
    const f = await fixture();
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    f.coordinator.publishRuntime({ ...runtime, connected: true }); await f.coordinator.refresh();
    f.coordinator.removeWorkspace(target); await f.coordinator.refresh();
    expect(f.rows).toEqual([]);
    expect(f.coordinator.readPreferences({ ...target, ...context }).forwardingEnabled).toBe(false);
    f.coordinator.setPreferences({ ...target, ...context }, { forwardingEnabled: true });
    await f.coordinator.dispose({ pruneAccount: true });
    expect(f.preferences.read({ ...target, deviceId: context.deviceId, accountId: "account-a" }).forwardingEnabled).toBe(false);
  });
});
