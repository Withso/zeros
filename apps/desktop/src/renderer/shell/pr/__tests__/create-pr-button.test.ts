import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const fixture = vi.hoisted(() => ({
  menu: new Map<string, () => void>(),
  status: vi.fn(), diff: vi.fn(), commit: vi.fn(), log: vi.fn(), create: vi.fn(), access: vi.fn(), catalog: vi.fn(), authority: vi.fn(), scope: vi.fn(),
  claim: vi.fn(), release: vi.fn(), refresh: vi.fn(), notify: vi.fn(), toast: vi.fn(), send: vi.fn(), open: vi.fn(), discover: vi.fn(),
}));
vi.mock("../../../platform/git", () => ({
  gitStatus: fixture.status, gitDiff: fixture.diff, gitCommit: fixture.commit, gitLog: fixture.log,
  ghPrCreate: fixture.create, ghRepoAccess: fixture.access,
  gitChangeCounts: vi.fn().mockResolvedValue({ uncommitted: 2 }), gitRepoBranchCatalog: fixture.catalog,
  isGitErrorShape: (error: unknown) => !!error && typeof error === "object" && "code" in error,
  isWorkspaceOpStillRunning: (error: unknown) => error instanceof Error && error.message === "Request timeout: WORKSPACE_REQUEST",
}));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: fixture.open }));
vi.mock("../../../platform/cloud-github-pr", () => ({ cloudGithubPrAuthority: fixture.authority }));
vi.mock("../../../platform/cloud-github-pr-scope", () => ({ cloudGithubPrScope: fixture.scope }));
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
  splitTriggerClasses: () => ({ shell: "", main: "", chevron: "" }) }));
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

const cloudId = "cloud://22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333";
const workspace = (id: string): Workspace => ({ id, path: id, repoRoot: id, repoSlug: "fixture/repo", branch: "feature", baseBranch: "main" } as Workspace);
const authority = () => ({ connectionGeneration: "selected:1", repositoryId: "91", repository: "moved/repo", branch: "feature", baseBranch: "main", contextRevision: "3" });
const render = (id: string, originUrl: string | null = "https://github.com/fixture/repo.git") => renderToStaticMarkup(React.createElement(CreatePrButton, { workspace: workspace(id), originUrl }));
beforeEach(() => {
  vi.clearAllMocks(); fixture.menu.clear();
  fixture.claim.mockImplementation(id => ({ id }));
  fixture.access.mockResolvedValue({ state: "ok" });
  fixture.catalog.mockResolvedValue(null);
  fixture.authority.mockImplementation(authority);
  fixture.scope.mockReturnValue("lifetime:1");
  fixture.status.mockResolvedValue({ staged: [], unstaged: [{ path: "Code.ts" }], untracked: ["Design/page.html"], conflicted: [], conflictState: null });
  fixture.diff.mockResolvedValue({ hunks: [], files: [{ path: "Code.ts" }] });
  fixture.commit.mockResolvedValue({ sha: "fixture-sha", branch: "feature" });
  fixture.log.mockResolvedValue([{ message: "Update source" }]);
  fixture.create.mockResolvedValue({ number: 42 });
  fixture.discover.mockResolvedValue(undefined);
});

it.each(["fixture/repo", "personal/fork"])("keeps cloud PR instructions on the verified repository when origin names %s", async repository => {
  fixture.catalog.mockResolvedValue({ effectiveRemote: "origin", remotes: [{ name: "origin", url: `https://github.com/${repository}.git`, isGitHub: true }] });
  fixture.send.mockReturnValue(false);
  render(cloudId);
  fixture.menu.get("Create draft PR")!();
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
  const text = fixture.send.mock.calls[0][0].text;
  expect(text).toContain("gh pr create --repo 'moved/repo' --draft");
  expect(text).toContain("git push -u 'https://github.com/moved/repo.git' HEAD:'feature'");
  expect(text).not.toContain(`--repo '${repository}'`);
  expect(text).not.toContain("git push -u 'origin'");
});

it.each(["personal-local", "organization-local"])("retains the configured remote and unknown-access recovery for %s", async id => {
  fixture.access.mockResolvedValue({ state: "unknown" });
  fixture.catalog.mockResolvedValue({ effectiveRemote: "origin", remotes: [{ name: "origin", url: "https://github.com/personal/fork.git", isGitHub: true }] });
  fixture.send.mockReturnValue(false);
  render(id);
  fixture.menu.get("Create draft PR")!();
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
  expect(fixture.send.mock.calls[0][0].text).toContain("gh pr create --repo 'personal/fork'");
  expect(fixture.send.mock.calls[0][0].text).toContain("git push -u 'origin' HEAD:'feature'");
  expect(fixture.authority).not.toHaveBeenCalled();
});

it.each(["unknown access", "missing identity", "different branch"])("does not send a cloud PR brief with %s", async reason => {
  if (reason === "unknown access") fixture.access.mockResolvedValue({ state: "unknown" });
  if (reason === "missing identity") fixture.authority.mockReturnValue(undefined);
  if (reason === "different branch") fixture.authority.mockReturnValue({ ...authority(), branch: "other" });
  fixture.send.mockReturnValue(false);
  render(cloudId);
  fixture.menu.get("Create draft PR")!();
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.commit).not.toHaveBeenCalled();
  expect(fixture.toast).toHaveBeenCalledWith("Refresh this workspace's GitHub status", expect.any(Object));
});

it.each(["connection", "branch", "repository", "withdrawn", "lifetime"])("rejects a cloud PR brief after its %s changes during Git reads", async change => {
  let finish!: (value: unknown) => void;
  fixture.status.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  fixture.send.mockReturnValue(false);
  render(cloudId);
  fixture.menu.get("Create draft PR")!();
  await vi.waitFor(() => expect(fixture.status).toHaveBeenCalledOnce());
  const next = authority();
  if (change === "connection") next.connectionGeneration = "selected:2";
  if (change === "branch") next.branch = "other";
  if (change === "repository") next.repository = "transferred/repo";
  if (change === "lifetime") fixture.scope.mockReturnValue("lifetime:2");
  fixture.authority.mockReturnValue(change === "withdrawn" ? undefined : next);
  finish({ conflicted: [], conflictState: null });
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
  expect(fixture.send).not.toHaveBeenCalled();
});

it("opens the verified cloud compare page even when origin names a fork", async () => {
  fixture.catalog.mockResolvedValue({ effectiveRemote: "origin", remotes: [{ name: "origin", url: "https://github.com/personal/fork.git", isGitHub: true }] });
  render(cloudId);
  fixture.menu.get("Create PR manually")!();
  await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
  expect(fixture.open).toHaveBeenCalledWith("https://github.com/moved/repo/compare/main...feature?expand=1");
});

it("keeps an unverified cloud identity out of the manual compare link", async () => {
  fixture.authority.mockReturnValue(undefined);
  render(cloudId);
  fixture.menu.get("Create PR manually")!();
  await vi.waitFor(() => expect(fixture.toast).toHaveBeenCalled());
  expect(fixture.open).not.toHaveBeenCalled();
});

it.each(["personal-local", "organization-local"])("uses the configured compare remote for %s", async id => {
  fixture.catalog.mockResolvedValue({ effectiveRemote: "upstream", remotes: [{ name: "upstream", url: "https://github.com/project/upstream.git", isGitHub: true }] });
  render(id);
  fixture.menu.get("Create PR manually")!();
  await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
  expect(fixture.open).toHaveBeenCalledWith("https://github.com/project/upstream/compare/main...feature?expand=1");
  expect(fixture.access).not.toHaveBeenCalled();
  expect(fixture.authority).not.toHaveBeenCalled();
});

it.each(["personal-local", "organization-local", cloudId])("refreshes cloud PR discovery when an accepted Create PR turn settles (%s)", async id => {
  fixture.send.mockReturnValue(true);
  render(id);
  fixture.menu.get("Create draft PR")!();
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
  expect(fixture.discover).not.toHaveBeenCalled();
  expect(fixture.release).not.toHaveBeenCalled();
  fixture.send.mock.calls[0][0].onSettled();
  expect(fixture.release).toHaveBeenCalledOnce();
  if (id.startsWith("cloud://")) expect(fixture.discover).toHaveBeenCalledWith(id);
  else expect(fixture.discover).not.toHaveBeenCalled();
});

it.each([null, "", " ", "https://gitlab.com/fixture/repo.git"])("offers no PR entry point without a GitHub remote (%s)", originUrl => {
  for (const id of ["personal-local", "organization-local", cloudId]) {
    expect(render(id, originUrl)).toBe("");
    expect(fixture.menu.size).toBe(0);
  }
  expect(fixture.access).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
});

it.each([
  ["personal-local", false], ["organization-local", true], [cloudId, false], [cloudId, true],
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
  render(cloudId);
  fixture.menu.get("Create PR directly")!();
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
  expect(fixture.commit).toHaveBeenCalledOnce();
  expect(fixture.refresh).toHaveBeenCalledWith(cloudId);
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
