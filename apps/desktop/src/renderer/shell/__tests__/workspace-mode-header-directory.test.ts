import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "../../platform/git";
import { TooltipProvider } from "../../shared/ui/primitives/tooltip";
import {
  WorkspaceModeHeader,
  WorkspaceModeToggle,
} from "../../shared/ui/workspace-mode-header";
import { designDirectoryTargetKeyForWorkspace } from "../../state/design-directory-target";
import {
  beginWorkspaceModeSwitch,
  finishWorkspaceModeSwitch,
  usePendingWorkspacesStore,
} from "../../state/pending-workspaces";
import { designDirectoryTargetCache } from "../../state/read-caches";

// Server rendering uses Zustand's initial snapshot. Read the real pending
// store's current snapshot here to exercise the client transition states.
vi.mock("../../state/pending-workspaces", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/pending-workspaces")>();
  return { ...actual, usePendingWorkspaceMode: actual.pendingWorkspaceMode };
});

function workspace(id: string): Workspace {
  return {
    id,
    kind: "design",
    repoSlug: id,
    repoRoot: `/fixture/${id}`,
    path: `/fixture/${id}/workspace`,
    branch: "design",
    baseBranch: "main",
    status: "in-progress",
    createdAt: 1,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
  };
}

function directoryName(owner: Workspace): string | undefined {
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(WorkspaceModeHeader, { workspace: owner }),
    ),
  );
  return markup.match(
    /<span[^>]*data-design-directory-name=""[^>]*>([^<]*)<\/span>/,
  )?.[1];
}

afterEach(() => {
  designDirectoryTargetCache.clear();
  usePendingWorkspacesStore.setState({ modeSwitches: {} });
});

describe("Workspace mode selection during a slow switch", () => {
  it.each(["code", "design"] as const)(
    "keeps the toggle on the confirmed %s surface until the engine commits",
    (confirmedMode) => {
      const owner = { ...workspace("alpha"), kind: confirmedMode };
      const requestedMode = confirmedMode === "code" ? "design" : "code";
      const render = (target: Workspace) =>
        renderToStaticMarkup(
          createElement(
            TooltipProvider,
            null,
            createElement(WorkspaceModeToggle, { workspace: target }),
          ),
        );
      const selectedMode = (target: Workspace) =>
        render(target).match(
          /data-workspace-mode="(code|design)"[^>]*aria-pressed="true"/,
        )?.[1];

      const token = beginWorkspaceModeSwitch(owner.id, requestedMode);
      expect(render(owner)).toContain('aria-busy="true"');
      expect(selectedMode(owner)).toBe(confirmedMode);
      // Other owners never inherit this pending intent, including A → B → A.
      const other = { ...workspace("beta"), kind: confirmedMode };
      expect(selectedMode(other)).toBe(confirmedMode);
      expect(render(other)).not.toContain('aria-busy="true"');
      expect(selectedMode(owner)).toBe(confirmedMode);

      // The authoritative row arrives before the pending token is cleared.
      const committed: Workspace = { ...owner, kind: requestedMode };
      expect(selectedMode(committed)).toBe(requestedMode);
      finishWorkspaceModeSwitch(owner.id, token);
      expect(selectedMode(committed)).toBe(requestedMode);
      expect(render(committed)).not.toContain('aria-busy="true"');

      // A refused transition never selects a mode whose surface did not open.
      const retry = beginWorkspaceModeSwitch(owner.id, requestedMode);
      expect(selectedMode(owner)).toBe(confirmedMode);
      finishWorkspaceModeSwitch(owner.id, retry);
      expect(selectedMode(owner)).toBe(confirmedMode);
    },
  );
});

describe("Design directory name during mode switches", () => {
  it.each(["code", "design"] as const)(
    "retains its name through a pending Code switch that settles in %s",
    (settledMode) => {
      const owner = workspace("alpha");
      designDirectoryTargetCache.setData(
        designDirectoryTargetKeyForWorkspace(owner.id),
        { directory: "Alpha - Design", exists: true },
      );
      expect(directoryName(owner)).toBe("Alpha - Design");

      const token = beginWorkspaceModeSwitch(owner.id, "code");
      expect(directoryName(owner)).toBe("Alpha - Design");
      // The retained header can still render while the confirmed surface
      // changes, or remain visible if the engine rejects the switch.
      const settledOwner = { ...owner, kind: settledMode };
      expect(directoryName(settledOwner)).toBe("Alpha - Design");
      finishWorkspaceModeSwitch(owner.id, token);
      expect(directoryName(settledOwner)).toBe("Alpha - Design");
    },
  );

  it("never borrows another workspace's name when switching owners mid-request", async () => {
    const alpha = workspace("alpha");
    const beta = workspace("beta");
    const alphaKey = designDirectoryTargetKeyForWorkspace(alpha.id);
    designDirectoryTargetCache.setData(alphaKey, {
      directory: "Alpha - Design",
      exists: true,
    });
    let resolveRefresh!: (value: {
      directory: string;
      exists: boolean;
    }) => void;
    const response = new Promise<{ directory: string; exists: boolean }>(
      (resolve) => {
        resolveRefresh = resolve;
      },
    );
    const refresh = designDirectoryTargetCache.load(alphaKey, () => response, {
      force: true,
    });
    beginWorkspaceModeSwitch(alpha.id, "code");
    expect(directoryName(alpha)).toBe("Alpha - Design");
    expect(directoryName(beta)).toBe("Design directory");

    resolveRefresh({ directory: "Renamed Alpha - Design", exists: true });
    await refresh;
    expect(directoryName(beta)).toBe("Design directory");
    designDirectoryTargetCache.setData(
      designDirectoryTargetKeyForWorkspace(beta.id),
      { directory: "Beta - Design", exists: true },
    );
    expect(directoryName(beta)).toBe("Beta - Design");
    expect(directoryName(alpha)).toBe("Renamed Alpha - Design");
  });
});
