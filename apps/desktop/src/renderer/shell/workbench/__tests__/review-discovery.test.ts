import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";
import { publishWorkspacePrDiscovery } from "../../pr/workspace-pr-discovery-state";
import { forgetPrCachesForWorkspace } from "../../pr/pr-cache-forget";
import { ReviewSurface } from "../tabs/review-surface";

const fixture = vi.hoisted(() => ({ workspace: null as Workspace | null, status: vi.fn() }));
vi.mock("../../../state/use-active-workspace", () => ({ useActiveWorkspace: () => ({ project: { originUrl: "https://github.com/fixture/repo.git" } }) }));
vi.mock("../../../state/store", () => ({ useWorkspaceDispatch: () => () => {} }));
vi.mock("../../use-git-refresh-key", () => ({ useGitRefreshKey: () => 1 }));
vi.mock("../../pr/use-agent-working", () => ({ useWorkspaceAgentWorking: () => false }));
vi.mock("../tab-status", () => ({
  useWorkbenchStatusSource: fixture.status,
  WorkbenchEmptyState: () => React.createElement("div", null, "Review status"),
}));
vi.mock("../tabs/review-tab", () => ({ ReviewView: () => React.createElement("div", null, "Confirmed PR") }));
vi.mock("../tabs/changes-tab", () => ({
  useSourceTarget: () => ({ workspace: fixture.workspace, isLocalMain: false, changesTarget: fixture.workspace?.id }),
  EmptyState: ({ title, subtitle }: { title: string; subtitle: string }) => React.createElement("div", null, title, subtitle),
}));

function render() {
  return renderToStaticMarkup(React.createElement(ReviewSurface, { tab: { id: "review", type: "review", title: "Review" }, active: true }));
}
afterEach(() => {
  if (fixture.workspace) forgetPrCachesForWorkspace(fixture.workspace.id);
  fixture.workspace = null; fixture.status.mockClear();
});

describe.each([null, "organization"])("PR discovery for Local owner %s", organizationId => {
  it("does not claim there is no PR before discovery finishes", () => {
    fixture.workspace = { id: "ws-review", path: "/workspace", repoSlug: "fixture", prNumber: null, placement: "local", organizationId } as Workspace;
    publishWorkspacePrDiscovery("ws-review", { pending: true, checked: false, error: null });
    expect(render()).not.toContain("No pull request");
  });

  it("reports failed discovery through the shared status banner with a retry", () => {
    fixture.workspace = { id: "ws-review", path: "/workspace", repoSlug: "fixture", prNumber: null, placement: "local", organizationId } as Workspace;
    const error = new Error("Connect GitHub to check pull requests");
    publishWorkspacePrDiscovery("ws-review", { pending: false, checked: false, error });
    expect(render()).not.toContain("No pull request");
    expect(fixture.status).toHaveBeenCalledWith(expect.objectContaining({ error, retry: expect.any(Function) }), expect.any(String));
  });

  it("shows the empty state only after a successful lookup found no PR", () => {
    fixture.workspace = { id: "ws-review", path: "/workspace", repoSlug: "fixture", prNumber: null, placement: "local", organizationId } as Workspace;
    publishWorkspacePrDiscovery("ws-review", { pending: false, checked: true, error: null });
    expect(render()).toContain("No pull request");
  });

  it("retains confirmed absence while a later refresh reports an error", () => {
    fixture.workspace = { id: "ws-review", path: "/workspace", repoSlug: "fixture", prNumber: null, placement: "local", organizationId } as Workspace;
    const error = new Error("GitHub is unavailable");
    publishWorkspacePrDiscovery("ws-review", { pending: false, checked: true, error });
    expect(render()).toContain("No pull request");
    expect(fixture.status).toHaveBeenCalledWith(expect.objectContaining({ error, hasContent: true }), expect.any(String));
  });

  it("renders a known PR even when an earlier discovery failed", () => {
    fixture.workspace = { id: "ws-review", path: "/workspace", repoSlug: "fixture", prNumber: 12, placement: "local", organizationId } as Workspace;
    publishWorkspacePrDiscovery("ws-review", { pending: false, checked: false, error: new Error("Earlier failure") });
    expect(render()).toContain("Confirmed PR");
    expect(fixture.status).toHaveBeenCalledWith(expect.objectContaining({ error: null, active: false }), expect.any(String));
  });
});

it("keeps cloud metadata outside the Local discovery error source", () => {
  const id = "cloud://organization/workspace";
  fixture.workspace = { id, path: id, repoSlug: "fixture", prNumber: null, placement: "cloud", organizationId: "organization" } as Workspace;
  publishWorkspacePrDiscovery(id, { pending: false, checked: false, error: new Error("Unsupported Local bridge operation") });
  expect(render()).toContain("No pull request");
  expect(fixture.status).toHaveBeenCalledWith(expect.objectContaining({ error: null, active: false }), expect.any(String));
});
