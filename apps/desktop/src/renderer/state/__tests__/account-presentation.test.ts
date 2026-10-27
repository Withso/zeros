import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspace-contract";
import { cloudScopedId, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import multiOrganizationFixture from "../../../../../../scripts/__tests__/fixtures/organization-list.json";
import type { OrganizationSummary } from "../../features/team/control-plane";

const io = vi.hoisted(() => ({ backend: "https://api.example.test", me: vi.fn(), remember: vi.fn(), reconcile: vi.fn(), prune: vi.fn() }));
vi.mock("../../features/team/control-plane", async original => ({
  ...await original<typeof import("../../features/team/control-plane")>(), get CONTROL_PLANE_URL() { return io.backend; }, controlPlane: { me: io.me },
}));
vi.mock("../../features/team/team-sync", () => ({ requestTeamResync: vi.fn() }));
vi.mock("../../features/team/organization-membership-history", async original => ({
  ...await original<typeof import("../../features/team/organization-membership-history")>(),
  rememberPersonalOrganizationOwnership: io.remember,
  reconcileOrganizationWorkspaceOwnership: io.reconcile,
}));
vi.mock("../../features/settings/settings-scope", async original => ({
  ...await original<typeof import("../../features/settings/settings-scope")>(), pruneScopedSettingsSelections: io.prune,
}));

const user = { sub: "account-a", email: "a@example.test", name: null, provider: "workos" as const };
const organizations = multiOrganizationFixture as OrganizationSummary[];
const target = { organizationId: organizations[18]!.id, workspaceId: "99999999-1111-4111-8111-111111111111" };
const folder = cloudWorkspaceKey(target), id = cloudScopedId(target, "chat");
const me = { user: { id: user.sub, email: user.email, displayName: null, staffRole: null }, organizations, teams: organizations };
const doc: CloudWorkspaceDocument = {
  id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId, createdBy: target.organizationId,
  name: "Saved workspace", placement: "cloud", status: "stopped", version: 1, error: null, deletedAt: null,
  createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z",
  capabilities: { canWrite: true, canStart: true, canManage: true, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
  generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "stopped", lastObservedAt: null },
};
let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  io.backend = "https://api.example.test";
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, localStorage });
});
afterEach(() => vi.unstubAllGlobals());

async function modules() {
  const [identity, team, catalog, selection, workspace, cache, account, boot] = await Promise.all([
    import("../account-presentation"), import("../../features/team/team-store"), import("../cloud-workspace-catalog"),
    import("../../features/team/active-team"), import("../store"), import("../cloud-chat-cache"),
    import("../../platform/account-presentation-cache"), import("../chat-boot-cache"),
  ]);
  return { identity, team, catalog, selection, workspace, cache, account, boot };
}

async function seed() {
  const m = await modules();
  m.identity.installAccountPresentationIdentity(user);
  m.team.acceptOrganizationSnapshot(me);
  m.selection.setActiveOrganizationSelection(target.organizationId, false);
  m.catalog.acceptCloudWorkspaceDocument(doc);
  const local = m.boot.sanitizeCachedChat({ id: "local", folder: "/local" })!;
  const cloud = m.boot.sanitizeCachedChat({ id, folder, title: "Saved chat" })!;
  m.workspace.useWorkspaceStore.getState().dispatch({ type: "MERGE_CHATS", chats: [local, cloud] });
  m.workspace.useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: id });
  m.cache.persistWorkspaceChatCache("chats-v1", [local, cloud]);
  storage.set("zeros:ui-state:v1", JSON.stringify({ activePage: "workspace", activeChatId: id, lastWorkspaceFolder: folder, activeChatByFolder: { [folder]: id } }));
  const tabs = await import("../../shell/workbench/tab-model");
  tabs.saveScopes({ [folder]: tabs.defaultScopeFor(folder) });
  return m;
}

it("restores org, catalog, chat and panels before a live session, without membership authority or ownership side effects", async () => {
  await seed();
  vi.resetModules(); vi.clearAllMocks();
  const m = await modules();
  const panels = m.workspace.useWorkspaceStore.getState().workbenchByScope[folder];
  m.identity.installAccountPresentationIdentity(user);
  expect(m.team.getTeamStoreState().me).toBeNull();
  expect(m.team.getTeamStoreState().presentation?.organizations).toEqual(organizations);
  expect(m.selection.getActiveTeamId()).toBe(target.organizationId);
  expect(m.team.getActiveOrganizationIdSnapshot()).toBe(target.organizationId);
  expect(m.team.getActiveOrganizationSnapshot()?.id).toBe(target.organizationId);
  expect(m.catalog.getCloudProjects()[0]?.repoRoot).toBe(folder);
  expect(m.catalog.getCloudWorkspaceRows()[0]).toMatchObject({ id: folder, setupState: "passed" });
  expect(m.catalog.cloudWorkspaceCatalogConfirmed()).toBe(false);
  expect(m.workspace.selectActiveFolder(m.workspace.useWorkspaceStore.getState())).toBe(folder);
  expect(m.workspace.useWorkspaceStore.getState()).toMatchObject({ activePage: "workspace", activeChatId: id, pendingWorkspaceValidationFolder: folder });
  expect(m.workspace.useWorkspaceStore.getState().chats.map(chat => chat.id)).toEqual(["local", id]);
  expect(m.workspace.useWorkspaceStore.getState().workbenchByScope[folder]).toBe(panels);
  expect(io.remember).not.toHaveBeenCalled(); expect(io.reconcile).not.toHaveBeenCalled(); expect(io.prune).not.toHaveBeenCalled();
  expect(io.me).not.toHaveBeenCalled();
});

it.each(["sign-out", "account", "backend"])("purges account presentation on %s while preserving Local rows", async boundary => {
  let m = await seed();
  if (boundary === "backend") { io.backend = "https://other.example.test"; vi.resetModules(); m = await modules(); }
  m.identity.installAccountPresentationIdentity(boundary === "sign-out" ? null : boundary === "account" ? { ...user, sub: "account-b" } : user);
  expect(m.team.getTeamStoreState().presentation).toBeNull();
  expect(m.team.getTeamStoreState().me).toBeNull();
  expect(m.selection.getActiveTeamId()).toBeNull();
  expect(m.catalog.getCloudWorkspaceRows()).toEqual([]);
  expect(m.workspace.useWorkspaceStore.getState().chats.map(chat => chat.id)).toEqual(["local"]);
  expect(m.workspace.selectActiveFolder(m.workspace.useWorkspaceStore.getState())).toBeNull();
  expect(storage.has("zeros-cloud-chats:v2")).toBe(false);
  expect(storage.has("zeros-cloud-catalog:v1")).toBe(false);
  expect(storage.has("zeros-organizations:v1")).toBe(false);
});

it("fences a held membership read and chat write across account A → B → A", async () => {
  const m = await seed();
  let finish!: (value: typeof me) => void;
  io.me.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = m.team.refreshTeams();
  const generation = m.account.accountPresentationGeneration();
  const oldChats = m.workspace.useWorkspaceStore.getState().chats;
  m.identity.installAccountPresentationIdentity({ ...user, sub: "account-b" });
  m.identity.installAccountPresentationIdentity(user);
  finish(me); await pending;
  m.cache.persistWorkspaceChatCache("chats-v1", oldChats, generation);
  expect(m.team.getTeamStoreState().me).toBeNull();
  expect(m.team.getTeamStoreState().presentation).toBeNull();
  expect(m.cache.loadCloudChatCache()).toEqual([]);
  expect(io.reconcile).not.toHaveBeenCalled();
});

it("does not clear restored metadata when the same stored identity is read again", async () => {
  const m = await seed();
  const rows = m.catalog.getCloudWorkspaceRows(), chats = m.workspace.useWorkspaceStore.getState().chats;
  m.identity.installAccountPresentationIdentity({ ...user });
  expect(m.catalog.getCloudWorkspaceRows()).toBe(rows);
  expect(m.workspace.useWorkspaceStore.getState().chats).toBe(chats);
});

it("starts the boot transcript disk read during identity installation before asking for a live session", async () => {
  await seed();
  vi.resetModules(); vi.clearAllMocks();
  const m = await modules();
  const { cloudTranscriptCache } = await import("../local-transcript-cache");
  const read = vi.spyOn(cloudTranscriptCache, "read").mockImplementation(() => new Promise(() => {}));
  m.identity.installAccountPresentationIdentity(user);
  expect(read).toHaveBeenCalledWith(id);
  expect(io.me).not.toHaveBeenCalled();
  expect(m.workspace.useWorkspaceStore.getState().activeChatId).toBe(id);
});

it("retires cloud transcripts with account presentation while preserving Local transcripts", async () => {
  const m = await seed();
  const { cloudTranscriptCache, localTranscriptCache } = await import("../local-transcript-cache");
  cloudTranscriptCache.bindOwner(m.account.getAccountPresentationOwner(), false);
  const messages = [{ id: "answer", kind: "text" as const, role: "agent" as const, text: "Saved answer", createdAt: 1 }];
  cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: null });
  localTranscriptCache.remember("local", "/local", { messages, leadingPrompt: null });
  m.identity.installAccountPresentationIdentity(null);
  expect(cloudTranscriptCache.peek(id)).toBeNull();
  expect(localTranscriptCache.peek("local")?.messages).toBe(messages);
});

it.each(["chat", "workspace", "chat snapshot"])("prunes the exact cloud transcript on confirmed %s deletion", async boundary => {
  const m = await seed();
  const { cloudTranscriptCache } = await import("../local-transcript-cache");
  cloudTranscriptCache.bindOwner(m.account.getAccountPresentationOwner(), false);
  const other = { ...target, organizationId: organizations[1]!.id };
  const otherId = cloudScopedId(other, "chat");
  const messages = [{ id: "answer", kind: "text" as const, role: "agent" as const, text: "Saved answer", createdAt: 1 }];
  cloudTranscriptCache.remember(id, folder, { messages, leadingPrompt: null });
  cloudTranscriptCache.remember(otherId, cloudWorkspaceKey(other), { messages, leadingPrompt: null });
  if (boundary === "workspace") m.catalog.acceptCloudWorkspaceDocument({ ...doc, version: 2, status: "deleted", deletedAt: "2026-10-23T00:00:00Z" });
  else if (boundary === "chat") m.workspace.useWorkspaceStore.getState().dispatch({ type: "DELETE_CHAT", id });
  else m.workspace.useWorkspaceStore.getState().dispatch({ type: "HYDRATE_CHATS", chats: [], activeChatId: null, confirmedCloudWorkspaces: [folder], confirmedLocalChats: false });
  expect(cloudTranscriptCache.peek(id)).toBeNull();
  expect(cloudTranscriptCache.peek(otherId)?.messages).toBe(messages);
});

it("prunes only the deleted workspace's durable chat metadata even with identical native IDs", async () => {
  const m = await seed();
  const other = { organizationId: organizations[1]!.id, workspaceId: target.workspaceId };
  const otherChat = m.boot.sanitizeCachedChat({ id: cloudScopedId(other, "chat"), folder: cloudWorkspaceKey(other) })!;
  m.catalog.acceptCloudWorkspaceDocument({ ...doc, organizationId: other.organizationId, teamId: other.organizationId });
  m.cache.persistWorkspaceChatCache("chats-v1", [...m.workspace.useWorkspaceStore.getState().chats, otherChat]);
  m.catalog.acceptCloudWorkspaceDocument({ ...doc, version: 2, status: "deleted", deletedAt: "2026-10-23T00:00:00Z" });
  expect(m.cache.loadCloudChatCache().map(chat => chat.id)).toEqual([otherChat.id]);
  const { loadCloudCatalogPresentation } = await import("../cloud-catalog-cache");
  expect(loadCloudCatalogPresentation(m.account.getAccountPresentationOwner()!).map(row => row.organizationId)).toEqual([other.organizationId]);
});

it.each(["live", "reload"])("retires a cloud repository route on account replacement after %s", async phase => {
  let m = await seed();
  const project = m.catalog.getCloudProjects()[0]!;
  const dispatch = m.workspace.useWorkspaceStore.getState().dispatch;
  dispatch({ type: "SET_REPO_PAGE_VIEW", projectId: "local-project", view: "environment" });
  dispatch({ type: "OPEN_REPO_PAGE", projectId: project.id, view: "environment", workspaceListFilter: `repo:${project.id}` });
  if (phase === "reload") {
    // No previous workspace identity remains to incidentally prune the repo page.
    storage.set("zeros:ui-state:v1", JSON.stringify({ activePage: "repo", lastHomePage: "repo", activeRepoId: project.id,
      workspaceListFilter: `repo:${project.id}`, repoPageViewByProject: { [project.id]: "environment", "local-project": "environment" } }));
    vi.resetModules(); m = await modules();
  }
  m.identity.installAccountPresentationIdentity({ ...user, sub: "account-b" });
  expect(m.workspace.useWorkspaceStore.getState()).toMatchObject({ activePage: "dashboard", lastHomePage: "dashboard", activeRepoId: null,
    workspaceListFilter: "grouped", repoPageViewByProject: { "local-project": "environment" } });
  expect(m.workspace.useWorkspaceStore.getState().repoPageViewByProject[project.id]).toBeUndefined();
});

it("keeps the visible Local repository when retiring a remembered cloud workspace", async () => {
  const m = await seed();
  m.workspace.useWorkspaceStore.getState().dispatch({ type: "OPEN_REPO_PAGE", projectId: "local-project", view: "environment" });
  m.identity.installAccountPresentationIdentity({ ...user, sub: "account-b" });
  expect(m.workspace.useWorkspaceStore.getState()).toMatchObject({ activePage: "repo", activeRepoId: "local-project", lastHomePage: "repo" });
});

it.each(["corrupt", "oversized", "foreign-owner", "duplicate"])("rejects %s membership and catalog cache envelopes", async problem => {
  const m = await seed();
  const owner = m.account.getAccountPresentationOwner()!;
  const envelope = (value: unknown) => problem === "corrupt" ? "{invalid" : problem === "oversized" ? " ".repeat(2 * 1024 * 1024)
    : JSON.stringify({ version: 1, owner: problem === "foreign-owner" ? "another-account" : owner, value });
  storage.set("zeros-organizations:v1", envelope({ organizations: [organizations[0], organizations[0]], activeId: null }));
  storage.set("zeros-cloud-catalog:v1", envelope([doc, doc]));
  const membership = await import("../../features/team/organization-presentation-cache");
  const catalog = await import("../cloud-catalog-cache");
  expect(membership.loadOrganizationPresentation(owner)).toBeNull();
  expect(catalog.loadCloudCatalogPresentation(owner)).toEqual([]);
});

it("persists the complete membership list without inline logos exhausting its byte budget", async () => {
  const m = await seed();
  const { persistOrganizationPresentation, loadOrganizationPresentation } = await import("../../features/team/organization-presentation-cache");
  const owner = m.account.getAccountPresentationOwner()!;
  const logo = `data:image/png;base64,${"A".repeat(60 * 1024)}`;
  persistOrganizationPresentation(owner, organizations.map(org => ({ ...org, logo })), target.organizationId);
  expect(loadOrganizationPresentation(owner)).toEqual({ organizations, activeId: target.organizationId });
});

it("bounds the catalog while retaining an older selected workspace and permits other cache writes after quota failure", async () => {
  const m = await seed();
  const { persistCloudCatalogPresentation, loadCloudCatalogPresentation } = await import("../cloud-catalog-cache");
  const owner = m.account.getAccountPresentationOwner()!;
  const recent = Array.from({ length: 600 }, (_, index) => ({ ...doc,
    id: `${String(index + 1).padStart(8, "0")}-3333-4333-8333-333333333333`, updatedAt: "2026-10-23T00:00:00Z" }));
  persistCloudCatalogPresentation(owner, [doc, ...recent], folder);
  const snapshot = loadCloudCatalogPresentation(owner);
  expect(snapshot).toHaveLength(512);
  expect(snapshot.some(row => row.id === doc.id)).toBe(true);
  const write = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === "zeros-cloud-catalog:v1") throw new Error("Quota exceeded");
    write(key, value);
  };
  expect(() => persistCloudCatalogPresentation(owner, [doc], folder)).not.toThrow();
  m.selection.setActiveOrganizationSelection(organizations[1]!.id, false);
  const { loadOrganizationPresentation } = await import("../../features/team/organization-presentation-cache");
  expect(loadOrganizationPresentation(owner)?.activeId).toBe(organizations[1]!.id);
});

it("does not resurrect an older catalog snapshot when its replacement exceeds the byte bound", async () => {
  const m = await seed();
  const { persistCloudCatalogPresentation, loadCloudCatalogPresentation } = await import("../cloud-catalog-cache");
  const owner = m.account.getAccountPresentationOwner()!;
  expect(loadCloudCatalogPresentation(owner)).toEqual([doc]);
  const replacement = { ...doc, id: "99999999-2222-4222-8222-222222222222",
    error: { code: "large", message: "x".repeat(2 * 1024 * 1024) } };
  persistCloudCatalogPresentation(owner, [replacement], null);
  expect(loadCloudCatalogPresentation(owner).some(row => row.id === doc.id)).toBe(false);
});
