import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  session: { access_token: "fixture-session", user: { sub: "account-a", email: "a@example.test", name: null, provider: "workos" as const } },
  enabled: false, list: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); },
}));
vi.mock("../../features/auth/auth-store", async original => ({
  ...await original<typeof import("../../features/auth/auth-store")>(),
  getSession: async () => harness.session,
  onAuthStateChange: () => () => {},
}));
vi.mock("../../platform/cloud-capability", () => ({ cloudWorkspaceCapability: async () => ({ enabled: harness.enabled }) }));
vi.mock("../../platform/cloud-workspaces", async original => ({
  ...await original<typeof import("../../platform/cloud-workspaces")>(), listCloudWorkspaceCatalogSnapshot: harness.list,
}));

const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const chatId = "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:chat";
beforeEach(() => {
  vi.resetModules();
  harness.effects.length = 0;
  harness.enabled = false;
  harness.list.mockReset().mockResolvedValue({ workspaces: [], catalogVersion: null, complete: true });
  const storage = new Map([["zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", activeChatId: chatId, lastWorkspaceFolder: folder, activeChatByFolder: { [folder]: chatId } })]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("window", { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), localStorage });
});

it("starts catalog validation when authoritative membership arrives after a cold lifecycle mount", async () => {
  harness.enabled = true;
  const { CloudWorkspaceLifecycle } = await import("../cloud-workspace-lifecycle");
  const { acceptOrganizationSnapshot } = await import("../../features/team/team-store");
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  renderToStaticMarkup(createElement(CloudWorkspaceLifecycle));
  const off = harness.effects[0]!();
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.list).not.toHaveBeenCalled();
    const organizations = [{ id: "11111111-1111-4111-8111-111111111111", name: "Fixture", slug: "fixture", logo: null,
      role: "member" as const, isPersonal: false, defaultTeamId: null, workspaceCapabilities: { local: false, cloud: true },
      teamCapabilities: { multiple: false as const, canCreate: false as const } }];
    acceptOrganizationSnapshot({ user: { id: "account-a", email: "a@example.test", displayName: null, staffRole: null }, organizations, teams: organizations });
    expect(harness.list).toHaveBeenCalledOnce();
    await new Promise(resolve => setTimeout(resolve, 0));
    const { useWorkspaceStore, selectActiveFolder } = await import("../store");
    expect(selectActiveFolder(useWorkspaceStore.getState())).toBeNull();
  } finally { off?.(); }
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the saved cloud route and chat when the same account first installs", async () => {
  const { CloudWorkspaceLifecycle } = await import("../cloud-workspace-lifecycle");
  const { useWorkspaceStore, selectActiveFolder } = await import("../store");
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  renderToStaticMarkup(createElement(CloudWorkspaceLifecycle));
  const off = harness.effects[0]!();
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(folder);
    expect(useWorkspaceStore.getState()).toMatchObject({ activePage: "workspace", activeChatId: chatId, pendingWorkspaceValidationFolder: folder });
  } finally { off?.(); }
});
