import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
const harness = vi.hoisted(() => ({
  enabled: true, effects: [] as Array<() => void | (() => void)>, error: vi.fn(), failure: vi.fn(),
}));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}));
vi.mock("../../features/settings/internal-features", () => ({ useInternalFeatureActive: () => harness.enabled }));
vi.mock("../store", async original => {
  const actual = await original<typeof import("../store")>();
  return { ...actual, useWorkspaceStore: Object.assign(
    (selector: (state: ReturnType<typeof actual.useWorkspaceStore.getState>) => unknown) => selector(actual.useWorkspaceStore.getState()),
    { getState: actual.useWorkspaceStore.getState, subscribe: actual.useWorkspaceStore.subscribe },
  ) };
});
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { error: harness.error } }));
vi.mock("../workbench-availability", async original => ({ ...await original<typeof import("../workbench-availability")>(), recordWorkbenchConnectionFailure: harness.failure }));
import { CloudWorkspaceLifecycle } from "../cloud-workspace-lifecycle";
import { requestCloudWorkspaceOpen } from "../cloud-workspace-open-intent";
import { acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog, cloudCatalogGeneration, cloudWorkspaceDocument, manageCloudWorkspace } from "../cloud-workspace-catalog";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import { useWorkspaceStore } from "../workspace-store";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = `cloud://${target.organizationId}/${target.workspaceId}`;
const doc: CloudWorkspaceDocument = {
  id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId,
  createdBy: target.organizationId, name: "Fixture", placement: "cloud", status: "stopped", version: 1,
  createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", deletedAt: null, error: null,
  capabilities: { canWrite: true, canManage: false, canStart: false, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
  generation: { number: 1, architecture: "x86_64", observedState: "stopped", lastObservedAt: null,
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
};
let client: WorkspaceRuntimeClient;
let cleanup: void | (() => void);
beforeEach(() => {
  harness.effects.length = 0; harness.enabled = true; harness.error.mockClear(); harness.failure.mockClear();
  clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc);
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  client = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] });
  setActiveBridge(client);
  useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: null });
});
afterEach(() => { cleanup?.(); cleanup = undefined; client.dispose(); setActiveBridge(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("explicit cloud navigation intent", () => {
  it.each(["navigation", "interaction"].flatMap(intent => [false, true].map(rollback => ({ intent, rollback }))))("silently follows generation changes during a pending $intent wake (rollback=$rollback)", async ({ intent, rollback }) => {
    client.dispose(); let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const open = vi.fn(async () => {
      await ready;
      return { client: { status: "connected", onStatusChange: () => () => {}, on: () => () => {},
        request: async () => ({ type: "WORKSPACE_RESPONSE", result: { chats: [], chatDeletions: [] } }) },
        scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "local-main" }, release: () => {} } as never;
    });
    client = new WorkspaceRuntimeClient({ open, workspaces: () => [],
      identity: () => `${cloudCatalogGeneration()}:${cloudWorkspaceDocument(target)?.generation.number}`,
      wakeOwner: () => ({ account: String(cloudCatalogGeneration()), generation: cloudWorkspaceDocument(target)!.generation.number, stopVersion: 0,
        lifecyclePending: ["stopping", "waking", "provisioning", "setting_up"].includes(cloudWorkspaceDocument(target)!.status) }) });
    setActiveBridge(client);
    if (intent === "navigation") { CloudWorkspaceLifecycle(); cleanup = harness.effects[3](); requestCloudWorkspaceOpen(folder); }
    else interactions().input("pointerdown");
    const pending = client.openWorkspace(target);
    const stages = rollback ? [[2, "provisioning"], [2, "setting_up"], [1, "waking"], [1, "ready"]] as const
      : [[2, "stopping"], [2, "provisioning"], [2, "setting_up"], [2, "ready"]] as const;
    for (const [index, [generation, status]] of stages.entries()) {
      acceptCloudWorkspaceDocument({ ...doc, status, version: index + 2, generation: { ...doc.generation, number: generation } });
      client.pruneCloudConnections();
      expect(harness.failure).not.toHaveBeenCalled();
    }
    finish(); await pending; await Promise.resolve();
    expect(open).toHaveBeenCalledOnce(); expect(harness.error).not.toHaveBeenCalled(); expect(harness.failure).not.toHaveBeenCalled();
  });
  it.each(["navigation", "interaction"])("keeps an in-progress %s calm when its client safety wait ends", async intent => {
    acceptCloudWorkspaceDocument({ ...doc, version: 2, status: "setting_up" });
    vi.spyOn(client, "openWorkspace").mockRejectedValue(new Error("The workspace is still starting after fifteen minutes"));
    if (intent === "navigation") { CloudWorkspaceLifecycle(); cleanup = harness.effects[3](); requestCloudWorkspaceOpen(folder); }
    else interactions().input("keydown");
    await Promise.resolve(); await Promise.resolve();
    expect(harness.failure).not.toHaveBeenCalled(); expect(harness.error).not.toHaveBeenCalled();
  });
  function interactions(native = false) {
    const listeners = new Map<string, EventListener>();
    const invoke = vi.fn(async () => ({ available: true }));
    vi.stubGlobal("window", { addEventListener: (type: string, listener: EventListener) => { listeners.set(type, listener); },
      removeEventListener: (type: string) => { listeners.delete(type); }, setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
      ...(native ? { __ZEROS_NATIVE__: { invoke, on: () => () => {} } } : {}) });
    class InputElement { constructor(private readonly row: boolean | string = false) {} closest() { return this.row ? this : null; }
      getAttribute() { return typeof this.row === "string" ? this.row : null; } }
    vi.stubGlobal("Element", InputElement);
    Object.assign(document, { hasFocus: () => true });
    CloudWorkspaceLifecycle(); cleanup = harness.effects[4]();
    return { listeners, invoke, input: (type: string, row: boolean | string = false, trusted = true) => listeners.get(type)?.({
      isTrusted: trusted, target: new InputElement(row),
    } as unknown as Event) };
  }

  it("keeps local app interactions free of cloud presence, wake and native presence queries", () => {
    useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: "/local", repoRoot: "/local", chatId: null });
    const open = vi.spyOn(client, "openWorkspace"), send = vi.spyOn(client, "sendWorkspacePresence");
    const h = interactions(true);
    for (const event of ["pointerdown", "keydown", "wheel", "input", "focus", "blur"]) h.input(event);
    acceptCloudWorkspaceDocument({ ...doc, status: "ready", version: 2 });
    expect(open).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
  });

  it("wakes the selected cloud workspace from actions on the Settings page", () => {
    useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
    const open = vi.spyOn(client, "openWorkspace").mockResolvedValue(undefined);
    const h = interactions(); h.input("pointerdown");
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(target), { signal: expect.any(AbortSignal), reason: "interaction" });
  });
  it("keeps an explicit Stop stopped until input after that request", async () => {
    acceptCloudWorkspaceDocument({ ...doc, status: "ready", version: 2 });
    const api = await import("../../platform/cloud-workspaces");
    vi.spyOn(api, "changeCloudWorkspaceLifecycle").mockResolvedValue({ ...doc, status: "stopping", version: 3 });
    const open = vi.spyOn(client, "openWorkspace").mockResolvedValue(undefined);
    const h = interactions(); h.input("pointerdown");
    await manageCloudWorkspace(target, "stop");
    acceptCloudWorkspaceDocument({ ...doc, status: "stopped", version: 4 });
    expect(open).not.toHaveBeenCalled();
    h.input("keydown"); expect(open).toHaveBeenCalledOnce();
  });

  it("wakes from actions on the selected workspace's own sidebar row", () => {
    const open = vi.spyOn(client, "openWorkspace").mockResolvedValue(undefined);
    const h = interactions(); h.input("pointerdown", folder);
    expect(open).toHaveBeenCalledOnce();
  });

  it("keeps one incident retry budget when navigating within the same cloud workspace", async () => {
    acceptCloudWorkspaceDocument({ ...doc, version: 2, error: { code: "safety_stop", message: "Safety stop" } });
    const open = vi.spyOn(client, "openWorkspace").mockResolvedValue(undefined);
    const h = interactions(); h.input("keydown");
    await new Promise(resolve => setTimeout(resolve, 0));
    useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: `${folder}/src`, repoRoot: folder, chatId: null });
    h.input("keydown"); expect(open).toHaveBeenCalledOnce();
  });

  it("wakes from trusted app input, keeps hover/programmatic focus inert, and shares repeated gestures", async () => {
    const open = vi.spyOn(client, "openWorkspace").mockResolvedValue(undefined);
    const h = interactions();
    h.input("pointermove"); h.input("focusin"); h.input("pointerdown", false, false);
    expect(open).not.toHaveBeenCalled();
    h.input("pointerdown"); h.input("keydown"); h.input("input");
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(target), { signal: expect.any(AbortSignal), reason: "interaction" });
    await Promise.resolve();
    cleanup?.(); cleanup = undefined; expect(h.listeners.size).toBe(0);
  });

  it("does not wake the previous workspace from sidebar rows or retained surfaces", () => {
    const open = vi.spyOn(client, "openWorkspace").mockResolvedValue(undefined);
    const h = interactions();
    h.input("pointerdown", true); h.input("keydown", true); expect(open).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    h.input("pointerdown"); expect(open).not.toHaveBeenCalled();
  });

  it("retains visible presence on blur and releases it immediately when hidden", () => {
    acceptCloudWorkspaceDocument({ ...doc, status: "ready", version: 2 });
    const send = vi.spyOn(client, "sendWorkspacePresence").mockReturnValue(true);
    const h = interactions(); expect(send).not.toHaveBeenCalled();
    h.input("wheel"); expect(send).toHaveBeenLastCalledWith(expect.objectContaining(target), true);
    Object.assign(document, { hasFocus: () => false });
    h.listeners.get("blur")!({} as Event); expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(target), true);
    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    (vi.mocked(document.addEventListener).mock.calls.find(([event]) => event === "visibilitychange")![1] as () => void)();
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining(target), false);
  });

  it("keeps selection restore, catalog refresh and visibility inert; only a click opens compute", async () => {
    const open = vi.spyOn(client, "openWorkspace").mockResolvedValue(undefined);
    CloudWorkspaceLifecycle(); cleanup = harness.effects[3]();
    acceptCloudWorkspaceDocument({ ...doc, version: 2 });
    const visibility = vi.mocked(document.addEventListener).mock.calls[0][1] as () => void;
    visibility();
    expect(open).not.toHaveBeenCalled();
    requestCloudWorkspaceOpen(folder); requestCloudWorkspaceOpen(folder);
    expect(open).toHaveBeenCalledExactlyOnceWith(target, { signal: expect.any(AbortSignal) });
    await Promise.resolve();
  });

  it.each(["navigation", "hidden"])("cancels the pending open on %s without a stale error or another wake", async reason => {
    const open = vi.spyOn(client, "openWorkspace").mockImplementation((_target, options) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })));
    CloudWorkspaceLifecycle(); cleanup = harness.effects[3]();
    requestCloudWorkspaceOpen(folder);
    if (reason === "navigation") useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: "/local", repoRoot: "/local", chatId: null });
    else {
      Object.defineProperty(document, "visibilityState", { value: "hidden" });
      (vi.mocked(document.addEventListener).mock.calls[0][1] as () => void)();
    }
    expect(open.mock.calls[0][1]?.signal?.aborted).toBe(true);
    requestCloudWorkspaceOpen(folder);
    await Promise.resolve(); await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    expect(harness.error).not.toHaveBeenCalled();
  });

  it.each(["gate", "viewer", "other organization"])("does not wake from an intent without exact %s authority", reason => {
    harness.enabled = reason !== "gate";
    if (reason === "viewer") acceptCloudWorkspaceDocument({ ...doc, version: 2, capabilities: { ...doc.capabilities, canWrite: false } });
    const open = vi.spyOn(client, "openWorkspace");
    CloudWorkspaceLifecycle(); cleanup = harness.effects[3]();
    requestCloudWorkspaceOpen(reason === "other organization" ? folder.replace(target.organizationId, "33333333-3333-4333-8333-333333333333") : folder);
    expect(open).not.toHaveBeenCalled();
  });
});
