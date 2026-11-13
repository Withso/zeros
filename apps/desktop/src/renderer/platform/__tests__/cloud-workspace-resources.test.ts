// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  supports: new Set<string>(), requests: [] as Array<{ message: unknown; timeout: unknown }>,
  handlers: new Set<(message: unknown) => void>(),
  reply: (async (_message: unknown) => ({ type: "WORKSPACE_RESPONSE", op: "workspace.resources", result: {} })) as (message: unknown) => Promise<unknown>,
}));
vi.mock("../bridge/active-bridge", () => ({
  getActiveBridge: () => ({
    supportsEngineCapability: (capability: string, workspaceId: string) => bridge.supports.has(`${capability} ${workspaceId}`),
    requestConnected: (message: unknown, timeout: unknown) => { bridge.requests.push({ message, timeout }); return bridge.reply(message); },
    on: (type: string, handler: (message: unknown) => void) => {
      if (type !== "WORKSPACE_RESOURCES") return () => {};
      bridge.handlers.add(handler); return () => bridge.handlers.delete(handler);
    },
  }),
}));
import { readCloudWorkspaceResources, useCloudWorkspaceResources } from "../cloud-workspace-resources";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const a = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const b = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "33333333-3333-4333-8333-333333333333" };
const key = (target: typeof a) => `cloud://${target.organizationId}/${target.workspaceId}`;
const sample = (usedPercent: number) => ({ cpu: { cores: 4, usedPercent }, memory: { totalBytes: 8 * 2 ** 30, usedPercent: 50 },
  disk: { totalBytes: 64 * 2 ** 30, usedPercent: 10 }, sampledAt: 1 });
const roots: Array<{ unmount(): void }> = [];
beforeEach(() => {
  vi.useFakeTimers(); bridge.supports = new Set([`workspace-resources-v1 ${key(a)}`, `workspace-resources-v1 ${key(b)}`]); bridge.requests = [];
  bridge.reply = async () => ({ type: "WORKSPACE_RESPONSE", op: "workspace.resources", result: sample(12) });
});
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); vi.useRealTimers(); });

describe("cloud workspace resources", () => {
  it("R1: a watch-capable worker is asked once with watch:true, then its pushes update the sample; 60 s fallback; watch:false on close", async () => {
    bridge.supports.add(`workspace-resources-watch-v1 ${key(a)}`);
    let seen: unknown = null;
    function Probe({ active }: { active: boolean }) { seen = useCloudWorkspaceResources(a, active); return null; }
    const root = createRoot(document.createElement("div")); roots.push(root);
    await act(async () => root.render(createElement(Probe, { active: true })));
    expect(bridge.requests).toEqual([{ message: { type: "WORKSPACE_REQUEST", op: "workspace.resources", params: { workspaceId: key(a), watch: true } }, timeout: 10_000 }]);
    expect(seen).toEqual(sample(12));
    act(() => { for (const handler of bridge.handlers) handler({ type: "WORKSPACE_RESOURCES", workspaceId: key(a), result: sample(40) }); });
    expect(seen).toEqual(sample(40));
    act(() => { for (const handler of bridge.handlers) handler({ type: "WORKSPACE_RESOURCES", workspaceId: key(b), result: sample(90) }); });
    act(() => { for (const handler of bridge.handlers) handler({ type: "WORKSPACE_RESOURCES", workspaceId: key(a), result: { cpu: "bad" } }); });
    expect(seen).toEqual(sample(40));
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
    expect(bridge.requests).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(bridge.requests).toHaveLength(2);
    await act(async () => root.render(createElement(Probe, { active: false })));
    expect(bridge.requests.at(-1)).toEqual({ message: { type: "WORKSPACE_REQUEST", op: "workspace.resources", params: { workspaceId: key(a), watch: false } }, timeout: 10_000 });
    expect(bridge.handlers.size).toBe(0);
  });


  it("asks a worker that advertises the capability, with the workspace's own key", async () => {
    await expect(readCloudWorkspaceResources(a)).resolves.toEqual(sample(12));
    expect(bridge.requests).toEqual([{ message: { type: "WORKSPACE_REQUEST", op: "workspace.resources", params: { workspaceId: key(a) } }, timeout: 10_000 }]);
  });

  it("asks nothing of an older worker and treats a refusal or a malformed reply as no rows", async () => {
    bridge.supports.clear();
    await expect(readCloudWorkspaceResources(a)).resolves.toBeNull();
    expect(bridge.requests).toEqual([]);
    bridge.supports.add(`workspace-resources-v1 ${key(a)}`);
    bridge.reply = async () => ({ type: "WORKSPACE_ERROR", op: "workspace.resources", code: "UNSUPPORTED", message: "No." });
    await expect(readCloudWorkspaceResources(a)).resolves.toBeNull();
    bridge.reply = async () => ({ type: "WORKSPACE_RESPONSE", op: "workspace.resources", result: { cpu: "busy" } });
    await expect(readCloudWorkspaceResources(a)).resolves.toBeNull();
  });

  it("asks only while active, refreshes while it stays active, and stops when it closes", async () => {
    let seen: unknown;
    function Probe({ target, active }: { target: typeof a; active: boolean }) { seen = useCloudWorkspaceResources(target, active); return null; }
    const root = createRoot(document.createElement("div")); roots.push(root);
    await act(async () => root.render(createElement(Probe, { target: a, active: false })));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(bridge.requests).toHaveLength(0);
    await act(async () => root.render(createElement(Probe, { target: a, active: true })));
    expect(seen).toEqual(sample(12));
    bridge.reply = async () => ({ type: "WORKSPACE_RESPONSE", op: "workspace.resources", result: sample(40) });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(seen).toEqual(sample(40));
    expect(bridge.requests).toHaveLength(2);
    await act(async () => root.render(createElement(Probe, { target: a, active: false })));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(bridge.requests).toHaveLength(2);
  });

  it("never shows one workspace's sample for another, including a late reply", async () => {
    let seen: unknown, release!: () => void;
    function Probe({ target }: { target: typeof a }) { seen = useCloudWorkspaceResources(target, true); return null; }
    const root = createRoot(document.createElement("div")); roots.push(root);
    bridge.reply = () => new Promise(resolve => { release = () => resolve({ type: "WORKSPACE_RESPONSE", op: "workspace.resources", result: sample(99) }); });
    await act(async () => root.render(createElement(Probe, { target: a })));
    bridge.reply = async () => ({ type: "WORKSPACE_RESPONSE", op: "workspace.resources", result: sample(7) });
    await act(async () => root.render(createElement(Probe, { target: b })));
    expect(seen).toEqual(sample(7));
    await act(async () => { release(); await Promise.resolve(); });
    expect(seen).toEqual(sample(7));
  });
});
