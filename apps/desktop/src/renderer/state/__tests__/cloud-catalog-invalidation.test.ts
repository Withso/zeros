import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "@/renderer/platform/cloud-workspaces";

const state = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  workspacesChanged: vi.fn(),
  projectsChanged: vi.fn(),
}));
vi.mock("../../features/settings/internal-features", () => ({ useInternalFeatureActive: () => false }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (fn: () => void | (() => void)) => state.effects.push(fn),
}));
vi.mock("@/renderer/state/store", async (original) => ({
  ...(await original<typeof import("@/renderer/state/store")>()),
  useWorkspaceStore: Object.assign(
    vi.fn(() => null),
    {
      getState: () => ({ chats: [], dispatch: vi.fn() }),
    },
  ),
}));
vi.mock("@/renderer/state/use-projects", () => ({
  notifyWorkspacesChanged: state.workspacesChanged,
  notifyProjectsChanged: state.projectsChanged,
}));
vi.mock("@/renderer/features/auth/auth-store", () => ({
  getSession: () => new Promise(() => {}),
  onAuthStateChange: () => () => {},
}));
vi.mock("@/renderer/platform/cloud-workspace-access", () => ({
  cloudWorkspaceCapability: () => new Promise(() => {}),
}));
import { CloudWorkspaceLifecycle } from "@/renderer/state/cloud-workspace-lifecycle";
import {
  acceptCloudWorkspaceDocument,
  clearCloudWorkspaceCatalog,
  getCloudWorkspaceRows,
  subscribeCloudWorkspaces,
} from "@/renderer/state/cloud-workspace-catalog";

const doc = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  teamId: "11111111-1111-4111-8111-111111111111",
  name: "Audit fixture",
  placement: "cloud",
  createdBy: "11111111-1111-4111-8111-111111111111",
  status: "ready",
  version: 1,
  error: null,
  deletedAt: null,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
  capabilities: {
    canWrite: true,
    canManage: true,
    canStart: true,
    startUnavailableReason: null,
  },
  repository: {
    forge: "github.com",
    owner: "example",
    name: "fixture",
    revision: "refs/heads/main",
  },
  generation: {
    number: 1,
    architecture: "x86_64",
    observedState: "running",
    lastObservedAt: null,
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
  },
} as CloudWorkspaceDocument;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  clearCloudWorkspaceCatalog();
  state.effects.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it("an unchanged cloud document does not notify workspace consumers", () => {
  acceptCloudWorkspaceDocument(doc);
  const rows = getCloudWorkspaceRows();
  const listener = vi.fn();
  cleanups.push(subscribeCloudWorkspaces(listener));
  acceptCloudWorkspaceDocument(doc);
  expect(getCloudWorkspaceRows()).toBe(rows);
  expect(listener).not.toHaveBeenCalled();
});

it("a cloud catalog change does not invalidate every Local repository", () => {
  vi.stubGlobal("window", {
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  CloudWorkspaceLifecycle();
  const cleanup = state.effects[0]();
  if (cleanup) cleanups.push(cleanup);
  acceptCloudWorkspaceDocument(doc);
  expect(
    state.workspacesChanged.mock.calls.some(([slug]) => slug === "*"),
  ).toBe(false);
  const row = getCloudWorkspaceRows()[0];
  expect(state.workspacesChanged).toHaveBeenCalledExactlyOnceWith(row.repoSlug, [row.id]);
});

it("an unchanged poll with two cloud owners preserves ordering and every row reference", () => {
  acceptCloudWorkspaceDocument(doc);
  acceptCloudWorkspaceDocument({
    ...doc,
    id: "33333333-3333-4333-8333-333333333333",
    repository: { ...doc.repository, name: "other" },
  });
  const rows = getCloudWorkspaceRows();
  const listener = vi.fn();
  cleanups.push(subscribeCloudWorkspaces(listener));
  acceptCloudWorkspaceDocument(doc);
  expect(getCloudWorkspaceRows()).toBe(rows);
  expect(listener).not.toHaveBeenCalled();
});
