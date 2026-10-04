import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
const harness = vi.hoisted(() => ({
  enabled: true, effects: [] as Array<() => void | (() => void)>, error: vi.fn(),
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
import { CloudWorkspaceLifecycle } from "../cloud-workspace-lifecycle";
import { requestCloudWorkspaceOpen } from "../cloud-workspace-open-intent";
import { acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog } from "../cloud-workspace-catalog";
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
  harness.effects.length = 0; harness.enabled = true; harness.error.mockClear();
  clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc);
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  client = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] });
  setActiveBridge(client);
  useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: null });
});
afterEach(() => { cleanup?.(); cleanup = undefined; client.dispose(); setActiveBridge(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("explicit cloud navigation intent", () => {
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
