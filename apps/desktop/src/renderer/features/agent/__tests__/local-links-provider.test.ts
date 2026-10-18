import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalLinkSnapshot } from "../../../platform/local-link-snapshot";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  ownerListeners: new Set<() => void>(),
  owner: null as string | null,
  rollout: true,
  bridge: null as RuntimeClient | null,
  reads: vi.fn(),
  data: undefined as LocalLinkSnapshot | undefined,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    h.effects.push(effect);
  },
  useSyncExternalStore: (
    subscribe: (notify: () => void) => () => void,
    snapshot: () => unknown,
  ) => {
    h.cleanups.push(subscribe(() => {}));
    const value = snapshot();
    if (value && typeof value === "object" && "data" in value)
      h.data = value.data as LocalLinkSnapshot | undefined;
    return value;
  },
}));
vi.mock("../../../platform/bridge/use-bridge", () => ({
  useBridge: () => h.bridge,
  useBridgeStatus: () => h.bridge?.status,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => h.bridge,
  onActiveBridgeConnected: () => () => {},
}));
vi.mock("../../../platform/local-link-snapshot", () => ({
  readLocalLinkSnapshot: h.reads,
}));
vi.mock("../../../platform/local-links", () => ({
  openLocalLink: vi.fn(),
  resolveLocalLinkScheme: async () => "zeros-dev",
}));
vi.mock("../../../state/store", () => ({ useWorkspaceStore: () => [] }));
vi.mock("../../settings/agent-control-rollout", () => ({
  useAgentControlFeatureActive: () => h.rollout,
}));
vi.mock("../../team/team-store", () => ({
  getActiveOrganizationIdSnapshot: () => h.owner,
  getOrganizationStoreGeneration: () => 0,
  useActiveOrganization: () => {},
}));
vi.mock("../../team/active-team", () => ({
  subscribeActiveTeam: (listener: () => void) => {
    h.ownerListeners.add(listener);
    return () => {
      h.ownerListeners.delete(listener);
    };
  },
}));

import { LocalLinksProvider } from "../local-links/provider";
import {
  notifyProjectsChanged,
  notifyWorkspacesChanged,
} from "../../../state/use-projects";

const snapshot: LocalLinkSnapshot = { projects: [], workspaces: [], chats: [] };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function mount(active = true) {
  renderToStaticMarkup(
    createElement(LocalLinksProvider, { cwd: "/repo", active, children: null }),
  );
  for (const effect of h.effects.splice(0)) {
    const off = effect();
    if (off) h.cleanups.push(off);
  }
}
function selectOwner(owner: string | null) {
  h.owner = owner;
  for (const listener of h.ownerListeners) listener();
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  h.rollout = true;
  h.owner = null;
  h.bridge = {
    executionIdentity: { kind: "local" },
    status: "connected",
    on: vi.fn(() => () => {}),
    onStatusChange: vi.fn(() => () => {}),
  } as unknown as RuntimeClient;
  h.data = undefined;
  h.reads.mockReset().mockResolvedValue(snapshot);
});
afterEach(() => {
  for (const cleanup of h.cleanups.splice(0).reverse()) cleanup();
  h.effects.length = 0;
  vi.unstubAllGlobals();
});

describe("Local pill metadata lifecycle", () => {
  it("shares an aggregate read across transcripts and refreshes originator-only catalog changes", async () => {
    mount();
    mount();
    await flush();
    expect(h.reads).toHaveBeenCalledTimes(1);
    notifyWorkspacesChanged("repo");
    mount();
    await flush();
    expect(h.reads).toHaveBeenCalledTimes(2);
    notifyProjectsChanged();
    mount();
    await flush();
    expect(h.reads).toHaveBeenCalledTimes(3);
  });

  it.each(["hidden", "closed", "organization", "cloud"])(
    "does no metadata work for %s sources",
    async (source) => {
      h.rollout = source !== "closed";
      h.owner = source === "organization" ? "org" : null;
      if (source === "cloud")
        h.bridge = {
          ...h.bridge,
          executionIdentity: { kind: "cloud" },
        } as unknown as RuntimeClient;
      mount(source !== "hidden");
      notifyWorkspacesChanged("repo");
      notifyProjectsChanged();
      await flush();
      expect(h.reads).not.toHaveBeenCalled();
      expect(h.bridge?.on).not.toHaveBeenCalled();
      expect(h.bridge?.onStatusChange).not.toHaveBeenCalled();
    },
  );

  it("fences a pending A → B → A read even when the owner id returns unchanged", async () => {
    let resolveOld!: (snapshot: LocalLinkSnapshot) => void;
    h.reads.mockImplementationOnce(
      () =>
        new Promise<LocalLinkSnapshot>((resolve) => {
          resolveOld = resolve;
        }),
    );
    mount();
    await flush();
    selectOwner("org");
    mount();
    selectOwner(null);
    mount();
    await flush();
    expect(h.reads).toHaveBeenCalledTimes(2);
    resolveOld({
      ...snapshot,
      projects: [{ id: "old" } as LocalLinkSnapshot["projects"][number]],
    });
    await flush();
    mount();
    await flush();
    expect(h.reads).toHaveBeenCalledTimes(2);
    expect(h.data).toEqual(snapshot);
  });
});
