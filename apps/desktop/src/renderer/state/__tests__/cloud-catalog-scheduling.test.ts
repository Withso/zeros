import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSessionInfo } from "../../features/auth/auth-store";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  auth: new Set<(session: AuthSessionInfo | null) => void>(),
  session: vi.fn(),
  capability: vi.fn(),
  list: vi.fn(),
  mutation: vi.fn(),
  cache: vi.fn(),
  readCached: vi.fn(),
  activeChatId: undefined as string | undefined,
  restored: vi.fn(),
  dispatch: vi.fn(),
  workspacesChanged: vi.fn(),
  folder: "/local-personal",
  access: false,
  selection: new Set<() => void>(),
  stream: vi.fn(), streamSelect: vi.fn(), streamDispose: vi.fn(),
  rollout: false,
  members: null as string[] | null,
  membershipShape: "complete" as "complete" | "empty" | "legacy" | "missing personal",
  membership: new Set<() => void>(),
}));
vi.mock("../cloud-workspace-stream-rollout", () => ({ cloudCatalogStreamRolloutEnabled: () => h.rollout }));
vi.mock("../../features/team/team-store", async original => ({
  ...await original<typeof import("../../features/team/team-store")>(),
  getTeamStoreState: () => {
    const members = h.members?.map(id => ({ id, isPersonal: false })) ?? [];
    const organizations = h.membershipShape === "empty" ? [] : h.membershipShape === "missing personal" ? members
      : [{ id: "99999999-9999-4999-8999-999999999999", isPersonal: true }, ...members];
    return { status: h.members === null ? "idle" : "ready", me: h.members === null ? null : {
      organizations: h.membershipShape === "legacy" ? undefined : organizations,
      teams: organizations,
    } };
  },
  subscribeOrganizationSnapshots: (listener: () => void) => { h.membership.add(listener); return () => { h.membership.delete(listener); }; },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));
vi.mock("../../features/team/cloud-workspace-account-access", () => ({
  useCloudWorkspaceAccountAccess: () => false,
  hasCloudWorkspaceAccountAccess: () => h.access,
}));
vi.mock("../../features/auth/auth-store", () => ({
  getSession: h.session,
  onAuthStateChange: (listener: (session: AuthSessionInfo | null) => void) => {
    h.auth.add(listener);
    return () => { h.auth.delete(listener); };
  },
}));
vi.mock("../../platform/cloud-workspace-access", () => ({ cloudWorkspaceCapability: h.capability }));
vi.mock("../cloud-workspace-stream", () => ({ createCloudWorkspaceStream: h.stream }));
// The lifecycle and catalog are real. Replace their I/O boundaries, including
// the API module's catalog -> GitHub -> API import cycle, not the scheduler.
vi.mock("../../platform/cloud-workspaces", () => ({
  CloudWorkspaceDocumentSchema: { parse: (value: unknown) => value },
  CloudWorkspaceRecoveryInputSchema: { parse: (value: unknown) => value },
  listCloudWorkspaceDocuments: h.list,
  getCloudWorkspaceDocument: vi.fn(),
  changeCloudWorkspaceLifecycle: h.mutation,
  recoverCloudWorkspace: h.mutation,
}));
vi.mock("../store", async (original) => ({
  ...(await original<typeof import("../store")>()),
  selectActiveFolder: () => h.folder,
  useWorkspaceStore: Object.assign(() => h.folder, {
    getState: () => ({ chats: [], activeChatId: h.activeChatId, dispatch: h.dispatch }),
    subscribe: (listener: () => void) => { h.selection.add(listener); return () => { h.selection.delete(listener); }; },
  }),
}));
vi.mock("../use-projects", () => ({
  notifyProjectsChanged: vi.fn(),
  notifyWorkspacesChanged: h.workspacesChanged,
  pruneCloudWorkspaceCollections: vi.fn(),
}));
vi.mock("../cloud-chat-cache", () => ({
  loadCloudChatCache: h.cache,
  completeCloudChatCacheRestore: h.restored,
  persistWorkspaceChatCache: vi.fn(),
  setCloudChatCacheOwner: vi.fn(),
}));
vi.mock("../../platform/cloud-transcript-cache", async (original) => ({
  ...(await original<typeof import("../../platform/cloud-transcript-cache")>()),
  readCachedCloudTranscriptWindow: h.readCached,
}));
import { CloudWorkspaceLifecycle } from "../cloud-workspace-lifecycle";
import { setCloudWorkspaceStreamCoverage } from "../cloud-workspace-stream-coverage";
import {
  acceptCloudWorkspaceDocument,
  clearCloudWorkspaceCatalog,
  cloudWorkspaceDocument,
  getCloudWorkspaceRows,
  refreshCloudWorkspaceCatalog,
  subscribeCloudWorkspaceRefresh,
} from "../cloud-workspace-catalog";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder = `cloud://${target.organizationId}/${target.workspaceId}`;
function doc(version = 1, status = "ready"): CloudWorkspaceDocument {
  return {
    id: target.workspaceId, organizationId: target.organizationId,
    teamId: target.organizationId, createdBy: target.organizationId,
    name: "Catalog fixture", placement: "cloud", status, version, error: null, deletedAt: null,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: new Date(version * 1_000).toISOString(),
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
    generation: {
      number: 1, architecture: "x86_64", observedState: "running", lastObservedAt: null,
      resources: { cpuMillicores: 2_000, memoryMiB: 4_096, storageMiB: 20_480 },
    },
  };
}
function session(accountId = "account-a"): AuthSessionInfo {
  return { access_token: "synthetic", user: {
    accountId, sub: accountId, email: "fixture@example.test", name: null, provider: "workos",
  } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let cleanup: (() => void) | undefined;
let page: EventTarget & { visibilityState: string };
let browser: EventTarget;
let timerFirings = 0;
const flush = () => vi.advanceTimersByTimeAsync(0);
async function mount() {
  renderToStaticMarkup(createElement(CloudWorkspaceLifecycle));
  // Run the production account/catalog effect; other effects own independent
  // runtime/interaction behavior tested in the adjacent lifecycle suites.
  cleanup = h.effects.find(effect => effect.toString().includes("clearCloudWorkspaceCatalog"))!() || undefined;
  await flush();
}
function visibility(value: "hidden" | "visible") {
  page.visibilityState = value;
  page.dispatchEvent(new Event("visibilitychange"));
}
function auth(value: AuthSessionInfo | null) {
  for (const listener of h.auth) listener(value);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
  clearCloudWorkspaceCatalog();
  vi.clearAllMocks();
  h.effects.length = 0;
  h.auth.clear();
  h.folder = "/local-personal";
  h.access = false; h.selection.clear();
  h.rollout = false; h.members = null; h.membershipShape = "complete";
  h.membership.clear(); setCloudWorkspaceStreamCoverage(null);
  h.stream.mockReturnValue({ select: h.streamSelect, dispose: h.streamDispose });
  h.activeChatId = undefined;
  h.cache.mockReset().mockReturnValue([]);
  h.readCached.mockReset().mockResolvedValue(null);
  h.session.mockReset().mockResolvedValue(session());
  h.capability.mockReset().mockResolvedValue({ enabled: true });
  h.list.mockReset().mockResolvedValue([doc()]);
  timerFirings = 0;
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  browser = Object.assign(new EventTarget(), {
    setTimeout: (run: () => void, delay: number) => setTimeout(() => { timerFirings++; run(); }, delay),
    clearTimeout,
    setInterval: (run: () => void, delay: number) => setInterval(() => { timerFirings++; run(); }, delay),
    clearInterval,
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", page);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  clearCloudWorkspaceCatalog();
  setCloudWorkspaceStreamCoverage(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cloud catalog timer ownership", () => {
  const otherOrg = "33333333-3333-4333-8333-333333333333";
  const other = () => ({ ...doc(), id: "44444444-4444-4444-8444-444444444444", organizationId: otherOrg, teamId: otherOrg });
  const covered = (mixed = false) => setCloudWorkspaceStreamCoverage({ streamId: target.organizationId, leaseId: target.workspaceId,
    sequence: 1, revision: 1, state: "open", catalogRequired: false, organizations: [
      { organizationId: target.organizationId, deviceStream: true, presence: true },
      ...(mixed ? [{ organizationId: otherOrg, deviceStream: false, presence: false }] : []),
    ] });

  it("has no periodic catalog callbacks or reads for ten minutes with complete coverage, then restores global fallback on loss", async () => {
    h.rollout = true; h.members = [target.organizationId]; h.folder = folder;
    await mount(); const rows = getCloudWorkspaceRows(); covered();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.list).toHaveBeenCalledOnce(); expect(timerFirings).toBe(0); expect(getCloudWorkspaceRows()).toBe(rows);
    setCloudWorkspaceStreamCoverage(null); await flush();
    expect(h.list).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
  });

  it("polls only the uncovered member for ten minutes, even while a covered organization is transitioning", async () => {
    h.rollout = true; h.members = [target.organizationId, otherOrg]; h.folder = folder;
    h.list.mockImplementation(async (org?: string) => org ? [other()] : [doc(), other()]);
    await mount(); covered(true); acceptCloudWorkspaceDocument(doc(2, "waking"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.list.mock.calls.filter(args => args.length === 0)).toHaveLength(1);
    expect(h.list.mock.calls.filter(([org]) => org === otherOrg)).toHaveLength(20);
    expect(h.list.mock.calls.some(([org]) => org === target.organizationId)).toBe(false);
    expect(timerFirings).toBe(20); expect(cloudWorkspaceDocument(target)?.status).toBe("waking");
  });

  it.each([false, true])("preserves scoped resource refreshes for ten minutes with mixed coverage %s", async mixed => {
    h.rollout = true; h.members = mixed ? [target.organizationId, otherOrg] : [target.organizationId];
    h.list.mockImplementation(async (org?: string) => org ? [other()] : mixed ? [doc(), other()] : [doc()]);
    await mount(); covered(mixed);
    const observed: Array<ReadonlySet<string> | undefined> = [];
    const off = subscribeCloudWorkspaceRefresh(scope => observed.push(scope));
    try {
      // Unrelated publications cannot keep moving the resource deadline.
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(20_000); acceptCloudWorkspaceDocument(doc(i + 2, "waking"));
      }
      expect(observed.filter(scope => scope?.has(target.organizationId))).toHaveLength(20);
      expect(observed.filter(scope => scope?.has(otherOrg))).toHaveLength(mixed ? 20 : 0);
      expect(observed.every(scope => scope?.size === 1)).toBe(true);
      expect(h.list).toHaveBeenCalledTimes(mixed ? 21 : 1);
    } finally { off(); }
  });

  it("pauses resource refresh while hidden, catches up on resume and retires it on sign-out", async () => {
    h.rollout = true; h.members = [target.organizationId]; await mount(); covered();
    const refresh = vi.fn(), off = subscribeCloudWorkspaceRefresh(refresh);
    try {
      await vi.advanceTimersByTimeAsync(20_000); visibility("hidden");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refresh).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
      visibility("visible"); await flush();
      expect(refresh).toHaveBeenCalledExactlyOnceWith(new Set([target.organizationId]));
      auth(null); refresh.mockClear(); await vi.advanceTimersByTimeAsync(60_000);
      expect(refresh).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { off(); }
  });

  it("reanchors only the resource organizations actually observed by a completed read", async () => {
    h.rollout = true; h.members = [target.organizationId, otherOrg];
    h.list.mockImplementation(async (org?: string) => org === target.organizationId ? [doc()] : org ? [other()] : [doc(), other()]);
    await mount();
    setCloudWorkspaceStreamCoverage({ streamId: target.organizationId, leaseId: target.workspaceId,
      sequence: 1, revision: 1, state: "open", catalogRequired: false,
      organizations: h.members.map(organizationId => ({ organizationId, deviceStream: true, presence: false })) });
    const observed: Array<ReadonlySet<string> | undefined> = [];
    const off = subscribeCloudWorkspaceRefresh(scope => observed.push(scope));
    try {
      await vi.advanceTimersByTimeAsync(15_000); await refreshCloudWorkspaceCatalog([target.organizationId]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(observed).toEqual([new Set([target.organizationId]), new Set([otherOrg])]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(observed.at(-1)).toEqual(new Set([target.organizationId]));
      expect(h.list).toHaveBeenCalledTimes(2);
    } finally { off(); }
  });

  it.each(["guest", "unknown", "rollout off"])("keeps the global legacy cadence for %s organization knowledge", async kind => {
    h.rollout = kind !== "rollout off"; h.members = kind === "unknown" ? null : [target.organizationId];
    await mount(); covered(kind === "guest"); await vi.advanceTimersByTimeAsync(600_000);
    expect(h.list).toHaveBeenCalledTimes(21); expect(h.list.mock.calls.every(args => args.length === 0)).toBe(true);
    expect(timerFirings).toBe(20);
  });

  it("resumes observation when membership becomes unknown without waiting for the old cadence", async () => {
    h.rollout = true; h.members = [target.organizationId]; await mount(); covered();
    await vi.advanceTimersByTimeAsync(5_000); h.members = null;
    for (const changed of h.membership) changed(); await flush();
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "legacy", "missing personal"] as const)("keeps global fallback for a %s membership snapshot", async shape => {
    h.rollout = true; h.members = [target.organizationId]; h.membershipShape = shape;
    await mount(); covered(); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.list).toHaveBeenCalledTimes(3);
    expect(h.list.mock.calls.every(args => args.length === 0)).toBe(true);
  });

  it.each(["/local-personal", "/organization-local"])("constructs no stream for the native %s selection", async selected => {
    Object.assign(browser, { __ZEROS_NATIVE__: {} }); h.access = true; h.folder = selected;
    await mount(); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.stream).not.toHaveBeenCalled(); expect(h.list).toHaveBeenCalledTimes(3);
  });

  it("owns a lazy stream across cloud selection, visibility and account changes while retaining fallback polls", async () => {
    Object.assign(browser, { __ZEROS_NATIVE__: {} }); h.access = true;
    await mount(); expect(h.stream).not.toHaveBeenCalled();
    h.folder = folder; for (const changed of h.selection) changed();
    expect(h.stream).toHaveBeenCalledOnce(); expect(h.streamSelect).toHaveBeenLastCalledWith(target, true);
    visibility("hidden"); expect(h.streamSelect).toHaveBeenLastCalledWith(target, false);
    visibility("visible"); expect(h.stream).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); expect(h.list).toHaveBeenCalledTimes(2);
    h.folder = "/organization-local"; for (const changed of h.selection) changed();
    expect(h.streamSelect).toHaveBeenLastCalledWith(null, true);
    auth(null); expect(h.streamDispose).toHaveBeenCalledOnce();
  });

  it.each(["hidden", "signed out", "empty account", "disabled", "Local development"])(
    "has no passive timer or list request while %s", async (state) => {
      if (state === "hidden") page.visibilityState = "hidden";
      if (state === "signed out") h.session.mockResolvedValue(null);
      if (state === "empty account") h.session.mockResolvedValue(session(""));
      if (state === "disabled") h.capability.mockResolvedValue({ enabled: false });
      if (state === "Local development") Object.assign(browser, { __ZEROS_NATIVE__: { localDevelopment: true } });
      await mount();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.list).not.toHaveBeenCalled();
      expect(timerFirings).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["/local-personal", "/organization-local", folder])(
    "uses only the 30s fallback for stable catalogs with selected %s", async (selected) => {
      h.folder = selected;
      await mount();
      const rows = getCloudWorkspaceRows();
      expect(h.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(h.list).toHaveBeenCalledTimes(2);
      expect(timerFirings).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.list).toHaveBeenCalledTimes(3);
      expect(timerFirings).toBe(2);
      expect(getCloudWorkspaceRows()).toBe(rows);
      expect(h.mutation).not.toHaveBeenCalled();
      expect(h.workspacesChanged.mock.calls.some(([slug]) => slug === "*")).toBe(false);
    },
  );

  it("cancels when hidden and coalesces overdue visibility/focus refresh", async () => {
    await mount();
    visibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(timerFirings).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    visibility("visible");
    browser.dispatchEvent(new Event("focus"));
    await flush();
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.list).toHaveBeenCalledTimes(3);
    expect(timerFirings).toBe(1);
  });

  it("recomputes the next due time from transition events without starving the fallback", async () => {
    await mount();
    await vi.advanceTimersByTimeAsync(1_000);
    const waking = doc(2, "waking");
    h.list.mockResolvedValue([waking]);
    acceptCloudWorkspaceDocument(waking);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    const ready = doc(3);
    h.list.mockResolvedValue([ready]);
    acceptCloudWorkspaceDocument(ready);
    await vi.advanceTimersByTimeAsync(28_000);
    acceptCloudWorkspaceDocument({ ...ready, name: "Renamed" });
    expect(timerFirings).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.list).toHaveBeenCalledTimes(3);
    expect(timerFirings).toBe(2);
  });

  it("schedules no polling callbacks during a slow read and retains the exact-key rows", async () => {
    await mount();
    const rows = getCloudWorkspaceRows();
    const slow = deferred<CloudWorkspaceDocument[]>();
    h.list.mockReturnValueOnce(slow.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.list).toHaveBeenCalledTimes(2);
    const firings = timerFirings;
    await vi.advanceTimersByTimeAsync(60_000);
    browser.dispatchEvent(new Event("focus"));
    expect(getCloudWorkspaceRows()).toBe(rows);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(timerFirings).toBe(firings);
    expect(vi.getTimerCount()).toBe(0);
    slow.resolve([doc()]);
    await flush();
    expect(h.list).toHaveBeenCalledTimes(3); // One overdue read, no fan-out.
    expect(vi.getTimerCount()).toBe(1);
    expect(getCloudWorkspaceRows()).toBe(rows);
  });

  it("keeps catalog observation independent of slow cached transcript restoration", async () => {
    const cached = deferred<null>();
    h.folder = folder;
    h.activeChatId = "fixture-chat";
    h.cache.mockReturnValue([{ id: h.activeChatId, folder }]);
    h.readCached.mockReturnValueOnce(cached.promise);
    await mount();
    expect(h.readCached).toHaveBeenCalledExactlyOnceWith(h.activeChatId);
    expect(h.restored).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(timerFirings).toBe(1);
    expect(h.readCached).toHaveBeenCalledOnce();
    cached.resolve(null);
    await flush();
    expect(h.restored).toHaveBeenCalledExactlyOnceWith("account-a");
  });

  it("does not restore a cached chat whose workspace was removed during the cache read", async () => {
    const cached = deferred<null>();
    h.folder = folder;
    h.activeChatId = "fixture-chat";
    h.cache.mockReturnValue([{ id: h.activeChatId, folder }]);
    h.readCached.mockReturnValueOnce(cached.promise);
    await mount();
    acceptCloudWorkspaceDocument({ ...doc(2, "deleted"), deletedAt: "2026-10-14T00:00:01Z" });
    cached.resolve(null);
    await flush();
    expect(h.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "MERGE_CHATS" }));
    expect(h.restored).toHaveBeenCalledExactlyOnceWith("account-a");
  });

  it("coalesces a same-account auth refresh without retiring its exact-key rows", async () => {
    await mount();
    const rows = getCloudWorkspaceRows();
    const pending = deferred<CloudWorkspaceDocument[]>();
    h.list.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    auth(session());
    browser.dispatchEvent(new Event("focus"));
    expect(vi.getTimerCount()).toBe(0);
    expect(getCloudWorkspaceRows()).toBe(rows);
    pending.resolve([doc()]);
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.list).toHaveBeenCalledTimes(3);
    expect(getCloudWorkspaceRows()).toBe(rows);
    expect(timerFirings).toBe(2);
  });

  it.each([-3_600_000, 3_600_000])("keeps the fallback monotonic through a %sms wall-clock correction", async (change) => {
    await mount();
    vi.setSystemTime(Date.now() + change);
    browser.dispatchEvent(new Event("focus"));
    expect(h.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(timerFirings).toBe(1);
  });

  it("accepts hidden transition events without polling until visible and due", async () => {
    await mount();
    visibility("hidden");
    await vi.advanceTimersByTimeAsync(1_000);
    const waking = doc(2, "waking");
    h.list.mockResolvedValue([waking]);
    acceptCloudWorkspaceDocument(waking);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    visibility("visible");
    browser.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(499);
    expect(h.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(timerFirings).toBe(1);
  });

  it.each(["resolve", "reject"])("ignores retired A1/B %s after A2 starts", async (outcome) => {
    const a1 = deferred<CloudWorkspaceDocument[]>(), b = deferred<CloudWorkspaceDocument[]>(), a2 = deferred<CloudWorkspaceDocument[]>();
    h.list.mockReturnValueOnce(a1.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(a2.promise);
    await mount();
    auth(session("account-b"));
    auth(session());
    expect(h.list).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    if (outcome === "resolve") { a1.resolve([doc(1)]); b.resolve([doc(2)]); }
    else { a1.reject(new Error("late A1")); b.reject(new Error("late B")); }
    await flush();
    expect(cloudWorkspaceDocument(target)).toBeUndefined();
    expect(h.restored).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.list).toHaveBeenCalledTimes(3);
    a2.resolve([doc(3)]);
    h.list.mockResolvedValue([doc(3)]);
    await flush();
    expect(cloudWorkspaceDocument(target)?.version).toBe(3);
    expect(h.restored).toHaveBeenCalledExactlyOnceWith("account-a");
    expect(h.list).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps a failed read bounded by the same fallback and preserves visible rows", async () => {
    await mount();
    const rows = getCloudWorkspaceRows();
    h.list.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(30_000);
    browser.dispatchEvent(new Event("focus"));
    await flush();
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(getCloudWorkspaceRows()).toBe(rows);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(timerFirings).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.list).toHaveBeenCalledTimes(3);
  });

  it("does not recreate a hidden/signed-out timer after an in-flight response", async () => {
    const pending = deferred<CloudWorkspaceDocument[]>();
    h.list.mockReturnValueOnce(pending.promise);
    await mount();
    visibility("hidden");
    auth(null);
    pending.resolve([doc()]);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getCloudWorkspaceRows()).toEqual([]);
    expect(h.restored).not.toHaveBeenCalled();
    expect(timerFirings).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes subscriptions and any timer on unmount, including a late capability result", async () => {
    const capability = deferred<{ enabled: boolean }>();
    h.capability.mockReturnValueOnce(capability.promise);
    await mount();
    cleanup?.();
    cleanup = undefined;
    capability.resolve({ enabled: true });
    visibility("visible");
    browser.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.auth.size).toBe(0);
    expect(h.list).not.toHaveBeenCalled();
    expect(timerFirings).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
