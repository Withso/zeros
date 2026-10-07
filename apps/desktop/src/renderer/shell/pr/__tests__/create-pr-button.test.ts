import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const fixture = vi.hoisted(() => ({
  menu: new Map<string, () => void>(),
  status: vi.fn(), diff: vi.fn(), commit: vi.fn(), log: vi.fn(), create: vi.fn(), access: vi.fn(),
  claim: vi.fn(), release: vi.fn(), refresh: vi.fn(), notify: vi.fn(), toast: vi.fn(), send: vi.fn(), open: vi.fn(),
}));
vi.mock("../../../platform/git", () => ({
  gitStatus: fixture.status, gitDiff: fixture.diff, gitCommit: fixture.commit, gitLog: fixture.log,
  ghPrCreate: fixture.create, ghRepoAccess: fixture.access,
  gitChangeCounts: vi.fn(), gitRepoBranchCatalog: vi.fn(),
  isGitErrorShape: (error: unknown) => !!error && typeof error === "object" && "code" in error,
  isWorkspaceOpStillRunning: (error: unknown) => error instanceof Error && error.message === "Request timeout: WORKSPACE_REQUEST",
}));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: fixture.open }));
vi.mock("../../../features/settings/use-git-remote", () => ({ useGitRemote: () => "origin" }));
vi.mock("../../../features/settings/settings-navigation", () => ({ requestUserSettingsSection: vi.fn() }));
vi.mock("../../../state/store", () => ({ useWorkspaceDispatch: () => vi.fn() }));
vi.mock("../../../state/use-projects", () => ({ notifyWorkspacesChanged: fixture.notify }));
vi.mock("../../use-git-refresh-key", () => ({ triggerGitRefresh: fixture.refresh }));
vi.mock("../use-send-to-active-chat", () => ({ useSendToActiveChat: () => fixture.send }));
vi.mock("../use-agent-working", () => ({ useWorkspaceAgentWorking: () => false, AGENT_WORKING_REASON: "Agent is working" }));
vi.mock("../pr-create-claim", () => ({ usePrCreateActionClaimed: () => false, claimPrCreateAction: fixture.claim, releasePrCreateAction: fixture.release }));
vi.mock("../../../shared/ui/primitives", () => ({ Tooltip: ({ children, label }: { children: React.ReactNode; label: string }) => React.createElement("div", { "data-tooltip": label }, children),
  splitTriggerClassNames: { shell: "", main: "", chevron: "" } }));
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: { error: fixture.toast } }));
vi.mock("../../../shared/ui/primitives/dropdown-menu", () => {
  const pass = ({ children }: { children: React.ReactNode }) => children;
  return { DropdownMenu: pass, DropdownMenuTrigger: pass, DropdownMenuContent: pass,
    DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => {
      const label = renderToStaticMarkup(React.createElement(React.Fragment, null, children)).replace(/<[^>]*>/g, "").trim();
      fixture.menu.set(label, onSelect);
      return children;
    } };
});

import { CreatePrButton } from "../create-pr-button";

const workspace = (id: string): Workspace => ({ id, path: id, repoRoot: id, repoSlug: "fixture/repo", branch: "feature", baseBranch: "main" } as Workspace);
const render = (id: string) => renderToStaticMarkup(React.createElement(CreatePrButton, { workspace: workspace(id), originUrl: "https://github.com/fixture/repo.git" }));
beforeEach(() => {
  vi.clearAllMocks(); fixture.menu.clear();
  fixture.claim.mockImplementation(id => ({ id }));
  fixture.access.mockResolvedValue({ state: "ok" });
  fixture.status.mockResolvedValue({ staged: [], unstaged: [{ path: "Code.ts" }], untracked: ["Design/page.html"], conflicted: [], conflictState: null });
  fixture.diff.mockResolvedValue({ hunks: [], files: [{ path: "Code.ts" }] });
  fixture.commit.mockResolvedValue({ sha: "fixture-sha", branch: "feature" });
  fixture.log.mockResolvedValue([{ message: "Update source" }]);
  fixture.create.mockResolvedValue({ number: 42 });
});

it.each([
  ["personal-local", false], ["organization-local", true], ["cloud://organization/workspace", false], ["cloud://organization/workspace", true],
] as const)("wires direct commit + create to the exact %s owner (draft=%s)", async (id, draft) => {
  const markup = render(id);
  expect(markup).toContain("Send PR creation to the agent");
  expect(markup).toContain("Create PR manually");
  fixture.menu.get(draft ? "Create draft directly" : "Create PR directly")!();
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
  expect(fixture.commit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: id, files: ["Code.ts", "Design/page.html"] }));
  expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: id, draft }));
  expect(fixture.refresh).toHaveBeenCalledWith(id);
  expect(fixture.send).not.toHaveBeenCalled();
});

it("refreshes a retained commit and explains it when PR publication fails", async () => {
  fixture.create.mockRejectedValue(new Error("Push failed"));
  render("cloud://organization/workspace");
  fixture.menu.get("Create PR directly")!();
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
  expect(fixture.commit).toHaveBeenCalledOnce();
  expect(fixture.refresh).toHaveBeenCalledWith("cloud://organization/workspace");
  expect(fixture.toast).toHaveBeenCalledWith("Couldn't create pull request", expect.objectContaining({ description: expect.stringContaining("committed") }));
});

it("keeps an ambiguous commit timeout distinct from a failed PR", async () => {
  fixture.commit.mockRejectedValue(new Error("Request timeout: WORKSPACE_REQUEST"));
  render("personal-local");
  fixture.menu.get("Create PR directly")!();
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.toast).toHaveBeenCalledWith("Still committing", expect.any(Object));
});
