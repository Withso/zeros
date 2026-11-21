// Create PR on the second repository of a workspace of several, through the
// real git.ts, routing and authority: only the transport and engine are stubs.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const fixture = vi.hoisted(() => ({
  menu: new Map<string, () => void>(),
  status: vi.fn(), diff: vi.fn(), commit: vi.fn(), log: vi.fn(), create: vi.fn(), access: vi.fn(), catalog: vi.fn(), authority: vi.fn(), scope: vi.fn(),
  cloud: vi.fn(), bridge: vi.fn(),
  claim: vi.fn(), release: vi.fn(), refresh: vi.fn(), notify: vi.fn(), toast: vi.fn(), send: vi.fn(), open: vi.fn(), discover: vi.fn(),
}));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: fixture.cloud }));
vi.mock("../../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 1 }));
vi.mock("../../../platform/cloud-github-pr-capability", () => ({
  hasCloudGithubPrCapability: () => true, cloudGithubPrCatalogContext: () => "context",
  cloudGithubPrCatalogKeys: () => [], onCloudGithubPrContextChange: () => () => {},
}));
vi.mock("../../../state/cloud-workspace-catalog", () => ({ refreshCloudWorkspace: vi.fn(async () => {}), cloudWorkspaceDocument: () => undefined }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => ({ request: fixture.bridge, requestConnected: fixture.bridge }) }));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: fixture.open }));
vi.mock("../../../features/settings/use-git-remote", () => ({ useGitRemote: () => "origin" }));
vi.mock("../../../features/settings/settings-navigation", () => ({ requestUserSettingsSection: vi.fn() }));
vi.mock("../../../state/store", () => ({ useWorkspaceDispatch: () => vi.fn() }));
vi.mock("../../../state/use-projects", () => ({ notifyWorkspacesChanged: fixture.notify }));
vi.mock("../../use-git-refresh-key", () => ({ triggerGitRefresh: fixture.refresh }));
vi.mock("../use-send-to-active-chat", () => ({ useSendToActiveChat: () => fixture.send }));
vi.mock("../use-agent-working", () => ({ useWorkspaceAgentWorking: () => false, AGENT_WORKING_REASON: "Agent is working" }));
vi.mock("../use-workspace-pr-sync", () => ({ retryWorkspacePrDiscovery: fixture.discover }));
vi.mock("../pr-create-claim", () => ({ usePrCreateActionClaimed: () => false, claimPrCreateAction: fixture.claim, releasePrCreateAction: fixture.release }));
vi.mock("../../../shared/ui/primitives", () => ({ Tooltip: ({ children, label }: { children: React.ReactNode; label: string }) => React.createElement("div", { "data-tooltip": label }, children),
  splitButtonClasses: () => ({ shell: "", action: "", chevron: "" }) }));
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: { error: fixture.toast } }));
vi.mock("../../../shared/ui/primitives/dropdown-menu", () => {
  const pass = ({ children }: { children: React.ReactNode }) => children;
  return { DropdownMenu: pass, DropdownMenuTrigger: pass, DropdownMenuContent: pass,
    DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => {
      // Strip markup until stable, so a split tag cannot survive one pass.
      let label = renderToStaticMarkup(React.createElement(React.Fragment, null, children)), previous;
      do { previous = label; label = label.replace(/<[^>]*>/g, ""); } while (label !== previous);
      label = label.trim();
      fixture.menu.set(label, onSelect);
      return children;
    } };
});

import { CreatePrButton } from "../create-pr-button";
import { publishCloudRepositoryLayouts } from "../../../platform/bridge/cloud-repository-routing";
import { clearCloudGithubPr } from "../../../platform/cloud-github-pr";

const root = "cloud://22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333";
const web = `${root}/web`;
const view = { id: web, path: web, repoRoot: root, repoSlug: "cloud-project", branch: "feature", baseBranch: "main" } as Workspace;
const render = () => renderToStaticMarkup(React.createElement(CreatePrButton, { workspace: view, originUrl: "https://github.com/withso/web.git" }));
beforeEach(() => {
  vi.clearAllMocks(); fixture.menu.clear(); clearCloudGithubPr();
  publishCloudRepositoryLayouts(new Map([[root, { repositories: [{ repository: "withso/api", folder: "api" }, { repository: "withso/web", folder: "web" }] }]]));
  fixture.claim.mockImplementation(id => ({ id }));
  // Each repository answers with its own authority; the bare workspace answers as the first.
  fixture.cloud.mockImplementation(async (_path: string, _schema: unknown, init: { body: { op: string; repository?: string } }) => ({
    authority: { connectionGeneration: "g1", repositoryId: init.body.repository === "withso/web" ? "44" : "43",
      repository: init.body.repository ?? "withso/api", branch: "feature", baseBranch: "main", contextRevision: "1" },
    result: init.body.op === "gh.repoAccess" ? { state: "ok" } : null,
  }));
  fixture.bridge.mockImplementation(async (message: { op: string }) => ({ type: "WORKSPACE_RESPONSE",
    result: message.op === "git.status" ? { staged: [], unstaged: [{ path: "a.ts" }], untracked: [], conflicted: [], conflictState: null, upstream: null }
      : message.op === "git.changeCounts" ? { all: 1, uncommitted: 1, staged: 0, unstaged: 1 } : {} }));
  fixture.discover.mockResolvedValue(undefined);
});

it("the agent brief names the selected repository, not the workspace's first", async () => {
  fixture.send.mockReturnValue(false);
  render();
  fixture.menu.get("Create draft PR")!();
  await vi.waitFor(() => expect(fixture.send.mock.calls.length + fixture.toast.mock.calls.length).toBe(1));
  expect(fixture.toast).not.toHaveBeenCalled();
  const text = fixture.send.mock.calls[0][0].text as string;
  expect(text).toContain("gh pr create --repo 'withso/web' --draft");
  expect(text).not.toContain("withso/api");
  expect(fixture.cloud.mock.calls.map(call => call[2].body.repository)).toEqual(["withso/web"]);
});

it("Create PR manually opens the selected repository's compare page", async () => {
  render();
  fixture.menu.get("Create PR manually")!();
  await vi.waitFor(() => expect(fixture.open.mock.calls.length + fixture.toast.mock.calls.length).toBe(1));
  expect(fixture.toast).not.toHaveBeenCalled();
  expect(fixture.open.mock.calls[0][0]).toMatch(/^https:\/\/github\.com\/withso\/web\/compare\/main\.\.\.feature/);
});
