import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  beginWorkspaceModeSwitch,
  beginPendingCreate,
  finishWorkspaceModeSwitch,
  finishPendingCreate,
  markWorkspaceSettling,
  clearWorkspaceSettling,
  clearWorkspaceArchiving,
  isWorkspaceArchiving,
  isWorkspaceProvisioning,
  markWorkspaceArchiving,
  pendingWorkspaceMode,
  usePendingWorkspacesStore,
} from "../pending-workspaces";

function reset(): void {
  usePendingWorkspacesStore.setState({
    creates: [],
    settlingFolders: {},
    archivingIds: {},
    modeSwitches: {},
  });
}

describe("pending-workspaces store", () => {
  beforeEach(reset);
  afterEach(() => vi.useRealTimers());

  it("beginPendingCreate registers an entry; finishPendingCreate removes it", () => {
    const token = beginPendingCreate({ repoRoot: "/r", repoSlug: "acme-app" });
    expect(usePendingWorkspacesStore.getState().creates).toHaveLength(1);
    expect(usePendingWorkspacesStore.getState().creates[0]).toMatchObject({
      token,
      repoRoot: "/r",
      repoSlug: "acme-app",
    });
    finishPendingCreate(token);
    expect(usePendingWorkspacesStore.getState().creates).toHaveLength(0);
  });

  it("finishPendingCreate is idempotent and leaves other creates alone", () => {
    const a = beginPendingCreate({ repoRoot: "/r", repoSlug: "acme-app" });
    const b = beginPendingCreate({ repoRoot: "/r", repoSlug: "acme-app" });
    expect(a).not.toBe(b); // tokens are unique even in the same millisecond
    finishPendingCreate(a);
    finishPendingCreate(a);
    const remaining = usePendingWorkspacesStore.getState().creates;
    expect(remaining.map((c) => c.token)).toEqual([b]);
  });

  it("markWorkspaceSettling / clearWorkspaceSettling round-trip", () => {
    markWorkspaceSettling("/ws/a");
    expect(
      usePendingWorkspacesStore.getState().settlingFolders["/ws/a"],
    ).toBeTypeOf("number");
    clearWorkspaceSettling("/ws/a");
    expect(
      usePendingWorkspacesStore.getState().settlingFolders["/ws/a"],
    ).toBeUndefined();
    // Clearing an absent key must not create churn (same state object back).
    const before = usePendingWorkspacesStore.getState();
    clearWorkspaceSettling("/ws/a");
    expect(usePendingWorkspacesStore.getState()).toBe(before);
  });

  it("distinguishes exact create provisioning from the longer surface-settling window", () => {
    const token = beginPendingCreate({
      repoRoot: "/r",
      repoSlug: "acme-app",
      path: "/ws/a",
    });
    markWorkspaceSettling("/ws/a");
    expect(isWorkspaceProvisioning("/ws/a")).toBe(true);
    finishPendingCreate(token);
    expect(isWorkspaceProvisioning("/ws/a")).toBe(false);
    expect(
      usePendingWorkspacesStore.getState().settlingFolders["/ws/a"],
    ).toBeTypeOf("number");
  });

  it("tracks and clears destructive-operation busy state", () => {
    markWorkspaceArchiving("ws_a");
    expect(isWorkspaceArchiving("ws_a")).toBe(true);
    expect(usePendingWorkspacesStore.getState().archivingIds.ws_a).toBeTypeOf(
      "number",
    );
    clearWorkspaceArchiving("ws_a");
    expect(isWorkspaceArchiving("ws_a")).toBe(false);

    markWorkspaceArchiving("ws_b");
    expect(isWorkspaceArchiving("ws_b")).toBe(true);
  });

  it("tracks a new create independently from an in-flight archive", () => {
    markWorkspaceArchiving("ws_existing");
    const token = beginPendingCreate({
      repoRoot: "/r",
      repoSlug: "acme-app",
      branch: "zeros/new-work",
    });

    const state = usePendingWorkspacesStore.getState();
    expect(state.archivingIds.ws_existing).toBeTypeOf("number");
    expect(state.creates.map((create) => create.token)).toEqual([token]);

    clearWorkspaceArchiving("ws_existing");
    expect(usePendingWorkspacesStore.getState().creates).toHaveLength(1);
  });

  it("publishes a mode request immediately and ignores stale completions", () => {
    const design = beginWorkspaceModeSwitch("ws_a", "design");
    expect(pendingWorkspaceMode("ws_a")).toBe("design");

    const code = beginWorkspaceModeSwitch("ws_a", "code");
    finishWorkspaceModeSwitch("ws_a", design);
    expect(pendingWorkspaceMode("ws_a")).toBe("code");

    finishWorkspaceModeSwitch("ws_a", code);
    expect(pendingWorkspaceMode("ws_a")).toBeNull();
  });
});
