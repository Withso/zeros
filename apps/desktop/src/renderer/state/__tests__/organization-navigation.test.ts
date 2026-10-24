import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationSummary } from "../../features/team/control-plane";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspace-contract";
import type { Workspace } from "../../platform/git";
import { cloudScopedId, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";

const io = vi.hoisted(() => ({ backend: "https://api.example.test", rows: [] as Workspace[] }));
vi.mock("../../features/team/control-plane", async original => ({
  ...await original<typeof import("../../features/team/control-plane")>(), get CONTROL_PLANE_URL() { return io.backend; },
}));
vi.mock("../../features/team/team-sync", () => ({ requestTeamResync: vi.fn() }));
vi.mock("../use-projects", async original => ({
  ...await original<typeof import("../use-projects")>(),
  peekLiveWorkspaceUnion: () => io.rows,
  peekWorkspacesFor: (slug: string) => io.rows.filter(row => row.repoSlug === slug),
}));

const personal = "local-personal";
const orgA = "11111111-1111-4111-8111-111111111111", orgB = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const targetA = { organizationId: orgA, workspaceId }, targetB = { organizationId: orgB, workspaceId };
const folderA = cloudWorkspaceKey(targetA), folderB = cloudWorkspaceKey(targetB);
const chatA = cloudScopedId(targetA, "chat"), chatB = cloudScopedId(targetB, "chat");
const user = { sub: "account-a", email: "a@example.test", name: null, provider: "workos" as const };
const organizations: OrganizationSummary[] = [personal, orgA, orgB].map(id => ({
  id, name: id, slug: id, logo: null, isPersonal: id === personal, role: "owner", defaultTeamId: null,
  workspaceCapabilities: { local: true, cloud: id !== personal }, teamCapabilities: { multiple: false, canCreate: false },
}));
const me = { user: { id: user.sub, email: user.email, displayName: null, staffRole: null }, organizations, teams: organizations };
const doc: CloudWorkspaceDocument = {
  id: workspaceId, organizationId: orgA, teamId: orgA, createdBy: orgA, name: "Remembered", placement: "cloud",
  status: "stopped", version: 1, error: null, deletedAt: null, createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z",
  capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "fixture", name: "fixture", revision: "main" },
  generation: { number: 1, architecture: "x86_64", observedState: "stopped", lastObservedAt: null,
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
};
let storage: Map<string, string>;
let stop: () => void;

beforeEach(() => {
  vi.resetModules();
  io.backend = "https://api.example.test";
  io.rows = [
    { id: "local", path: "/repo/local-work", repoRoot: "/repo", repoSlug: "repo", organizationId: null, placement: "local", archivedAt: null },
    { id: "team", path: "/team/team-work", repoRoot: "/team", repoSlug: "team", organizationId: orgA, placement: "local", archivedAt: null },
  ] as Workspace[];
  storage = new Map();
  storage.set("zeros-projects-v1", JSON.stringify(["repo", "team"].map(id => ({
    id, name: id, repoRoot: `/${id}`, repoSlug: id, originUrl: null, addedAt: 1,
  }))));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("window", { localStorage, setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  stop = () => {};
});
afterEach(() => { stop(); vi.unstubAllGlobals(); });

async function setup() {
  const [navigation, cache, store, selection, identity, team, catalog, boot, account, intent] = await Promise.all([
    import("../organization-navigation"), import("../organization-destination-cache"), import("../store"),
    import("../../features/team/active-team"), import("../account-presentation"), import("../../features/team/team-store"),
    import("../cloud-workspace-catalog"), import("../chat-boot-cache"), import("../../platform/account-presentation-cache"),
    import("../cloud-workspace-open-intent"),
  ]);
  identity.installAccountPresentationIdentity(user);
  team.acceptOrganizationSnapshot(me);
  catalog.restoreCloudWorkspaceCatalog([doc, { ...doc, organizationId: orgB, teamId: orgB }]);
  const chats = [
    { id: "local-chat", folder: "/repo/local-work" }, { id: "team-chat", folder: "/team/team-work" },
    { id: chatA, folder: folderA }, { id: cloudScopedId(targetA, "second"), folder: folderA }, { id: chatB, folder: folderB },
  ].map(boot.sanitizeCachedChat).filter(row => row !== null);
  store.useWorkspaceStore.getState().dispatch({ type: "MERGE_CHATS", chats });
  stop = navigation.observeOrganizationDestination();
  const dispatch = store.useWorkspaceStore.getState().dispatch;
  const open = (organizationId: string, folder: string, chatId: string | null) => {
    selection.setActiveOrganizationSelection(organizationId, organizationId === personal);
    dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder.startsWith("/repo/") ? "/repo" : folder.startsWith("/team/") ? "/team" : folder, chatId });
  };
  const switchTo = (organizationId: string) => {
    const previous = team.getActiveOrganizationSnapshot();
    selection.setActiveOrganizationSelection(organizationId, organizationId === personal);
    navigation.restoreOrganizationDestination(previous);
  };
  const state = () => {
    const current = store.useWorkspaceStore.getState();
    return { page: current.activePage, folder: store.selectActiveFolder(current), chatId: current.activeChatId };
  };
  return { navigation, cache, store, selection, identity, team, catalog, account, intent, dispatch, open, switchTo, state };
}

it("restores A → B → A with its last chat in one navigation and never requests a wake", async () => {
  const m = await setup();
  const wake = vi.fn(), offWake = m.intent.subscribeCloudWorkspaceOpens(wake);
  m.open(orgA, folderA, chatA);
  m.dispatch({ type: "SET_ACTIVE_CHAT", id: cloudScopedId(targetA, "second") });
  m.open(orgB, folderB, chatB);
  const snapshots: unknown[] = [];
  const off = m.store.useWorkspaceStore.subscribe(() => snapshots.push(m.state()));
  m.switchTo(orgA);
  off(); offWake();
  expect(snapshots).toEqual([{ page: "workspace", folder: folderA, chatId: cloudScopedId(targetA, "second") }]);
  expect(wake).not.toHaveBeenCalled();
  expect(m.catalog.cloudWorkspaceCatalogConfirmed()).toBe(false);
  expect(m.store.useWorkspaceStore.getState().pendingWorkspaceValidationFolder).toBe(folderA);
});

it("remembers Local Personal, organization-local and cloud destinations independently", async () => {
  const m = await setup();
  m.open(personal, "/repo/local-work", "local-chat");
  m.open(orgA, "/team/team-work", "team-chat");
  m.open(orgB, folderB, chatB);
  for (const [org, folder, chatId] of [[orgA, "/team/team-work", "team-chat"], [personal, "/repo/local-work", "local-chat"], [orgB, folderB, chatB]]) {
    m.switchTo(org);
    expect(m.state()).toEqual({ page: "workspace", folder, chatId });
  }
});

it("restores persisted organization destinations after module and store reload", async () => {
  let m = await setup();
  m.open(orgA, folderA, chatA);
  m.open(personal, "/repo/local-work", "local-chat");
  stop(); vi.resetModules();
  m = await setup();
  m.switchTo(orgA);
  expect(m.state()).toEqual({ page: "workspace", folder: folderA, chatId: chatA });
  m.switchTo(personal);
  expect(m.state()).toEqual({ page: "workspace", folder: "/repo/local-work", chatId: "local-chat" });
});

it("remembers the outgoing workspace when its catalog arrives after the initial navigation", async () => {
  const m = await setup();
  m.catalog.clearCloudWorkspaceCatalog();
  m.open(orgA, folderA, chatA);
  expect(m.cache.getOrganizationDestination(orgA)).toBeNull();
  m.catalog.restoreCloudWorkspaceCatalog([doc]);
  m.switchTo(personal);
  m.switchTo(orgA);
  expect(m.state()).toEqual({ page: "workspace", folder: folderA, chatId: chatA });
});

it.each(["unknown-local", "unknown-cloud", "deleted-cloud"])("falls back to Dashboard for an %s target", async kind => {
  const m = await setup();
  m.open(orgB, folderB, chatB);
  if (kind === "unknown-local") m.cache.rememberOrganizationDestination(orgA, "/missing/worktree", null);
  else if (kind === "unknown-cloud") m.cache.rememberOrganizationDestination(orgA,
    cloudWorkspaceKey({ ...targetA, workspaceId: "44444444-4444-4444-8444-444444444444" }), null);
  else {
    m.cache.rememberOrganizationDestination(orgA, folderA, chatA);
    m.catalog.acceptCloudWorkspaceDocument({ ...doc, version: 2, status: "deleted", deletedAt: "2026-10-23T00:00:00Z" });
    expect(m.cache.getOrganizationDestination(orgA)).toBeNull();
    expect(m.cache.getOrganizationDestination(orgB)?.folder).toBe(folderB);
  }
  m.switchTo(orgA);
  expect(m.state().page).toBe("dashboard");
});

it("prunes a deleted Local workspace's remembered destination through the existing reducer", async () => {
  const m = await setup();
  m.open(orgA, "/team/team-work", "team-chat");
  m.open(personal, "/repo/local-work", "local-chat");
  m.dispatch({ type: "REMOVE_WORKSPACE_UI_STATE", folder: "/team/team-work", repoRoot: "/team" });
  expect(m.cache.getOrganizationDestination(orgA)).toBeNull();
  m.switchTo(orgA);
  expect(m.state().page).toBe("dashboard");
  m.switchTo(personal);
  expect(m.state().folder).toBe("/repo/local-work");
});

it.each(["repository", "workspace"])("preserves a separately registered nested owner's memory when deleting its outer %s", async removal => {
  const m = await setup();
  const nested = "/repo/local-work/nested";
  const projects = JSON.parse(storage.get("zeros-projects-v1")!);
  storage.set("zeros-projects-v1", JSON.stringify([...projects,
    { id: "nested", name: "Nested", repoRoot: nested, repoSlug: "nested", originUrl: null, addedAt: 2 },
  ]));
  io.rows.push({ ...io.rows[1]!, id: "nested", path: nested, repoRoot: nested, repoSlug: "nested" });
  const { sanitizeCachedChat } = await import("../chat-boot-cache");
  m.dispatch({ type: "MERGE_CHATS", chats: [sanitizeCachedChat({ id: "nested-chat", folder: nested })!] });
  m.open(personal, "/repo/local-work", "local-chat");
  m.open(orgA, nested, "nested-chat");
  m.dispatch(removal === "repository"
    ? { type: "REMOVE_REPO_UI_STATE", projectId: "repo", repoRoot: "/repo", workspaceFolders: ["/repo/local-work"] }
    : { type: "REMOVE_WORKSPACE_UI_STATE", folder: "/repo/local-work", repoRoot: "/repo" });
  expect(m.cache.getOrganizationDestination(personal)).toBeNull();
  expect(m.cache.getOrganizationDestination(orgA)?.folder).toBe(nested);
});

it.each(["account", "sign-out", "backend"])("retires cloud destination memory across %s A → B → A while retaining Local", async boundary => {
  const m = await setup();
  m.open(orgA, folderA, chatA);
  m.open(personal, "/repo/local-work", "local-chat");
  const generation = m.account.accountPresentationGeneration();
  if (boundary === "backend") io.backend = "https://other.example.test";
  m.identity.installAccountPresentationIdentity(boundary === "sign-out" ? null : boundary === "account" ? { ...user, sub: "account-b" } : user);
  if (boundary === "backend") io.backend = "https://api.example.test";
  m.identity.installAccountPresentationIdentity(user);
  m.team.acceptOrganizationSnapshot(me);
  m.catalog.restoreCloudWorkspaceCatalog([doc]);
  m.cache.rememberOrganizationDestination(orgA, folderA, chatA, generation);
  m.switchTo(orgA);
  expect(m.state().page).toBe("dashboard");
  expect(m.cache.getOrganizationDestination(orgA)).toBeNull();
  m.switchTo(personal);
  expect(m.state()).toEqual({ page: "workspace", folder: "/repo/local-work", chatId: "local-chat" });
});

it.each(["cloud", "local"])("prunes %s destination memory on authoritative membership loss only", async placement => {
  const m = await setup();
  m.open(orgA, placement === "cloud" ? folderA : "/team/team-work", placement === "cloud" ? chatA : "team-chat");
  m.team.clearTeamStore();
  m.team.restoreOrganizationPresentation();
  expect(m.cache.getOrganizationDestination(orgA)).not.toBeNull();
  const retained = organizations.filter(org => org.id !== orgA);
  m.team.acceptOrganizationSnapshot({ ...me, organizations: retained, teams: retained });
  expect(m.cache.getOrganizationDestination(orgA)).toBeNull();
});

it("does not assign a workspace to the new owner during the switch notification", async () => {
  const m = await setup();
  m.open(orgA, folderA, chatA);
  m.selection.setActiveOrganizationSelection(orgB, false);
  m.dispatch({ type: "SET_ACTIVE_CHAT", id: cloudScopedId(targetA, "second") });
  expect(m.cache.getOrganizationDestination(orgB)).toBeNull();
  m.navigation.restoreOrganizationDestination();
  expect(m.state().page).toBe("dashboard");
});

it("rejects foreign cloud chat identities, corrupt versions and oversized envelopes", async () => {
  const m = await setup();
  const owner = m.account.getAccountPresentationOwner();
  for (const raw of ["invalid", " ".repeat(512 * 1024),
    JSON.stringify({ version: 2, entries: [[orgA, { folder: folderA, chatId: chatA, owner }]] }),
    JSON.stringify({ version: 1, entries: [[orgA, { folder: folderA, chatId: chatB, owner }]] }),
    JSON.stringify({ version: 1, entries: [[orgA, { folder: folderA, chatId: chatA, owner: "foreign" }]] }),
  ]) {
    storage.set("zeros-organization-destinations:v1", raw);
    expect(m.cache.getOrganizationDestination(orgA)).toBeNull();
  }
});

it("bounds organization memory by row count and bytes, retaining the newest selection", async () => {
  const m = await setup();
  for (let index = 0; index < 160; index++) m.cache.rememberOrganizationDestination(`owner-${index}`, `/local/${index}`, null);
  expect(m.cache.getOrganizationDestination("owner-0")).toBeNull();
  expect(JSON.parse(storage.get("zeros-organization-destinations:v1")!).entries).toHaveLength(128);
  for (let index = 0; index < 160; index++) m.cache.rememberOrganizationDestination(`owner-${index}`, `/local/${"x".repeat(4000)}/${index}`, "c".repeat(4000));
  expect(m.cache.getOrganizationDestination("owner-159")?.folder.endsWith("/159")).toBe(true);
  expect(m.cache.getOrganizationDestination("owner-0")).toBeNull();
  expect(storage.get("zeros-organization-destinations:v1")!.length * 2).toBeLessThanOrEqual(512 * 1024);
});
