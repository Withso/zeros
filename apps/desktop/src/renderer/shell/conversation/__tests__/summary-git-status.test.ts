import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const state = vi.hoisted(() => ({ error: null as Error | null, persistentError: null as Error | null }));
afterEach(() => { state.error = state.persistentError = null; });

vi.mock("../../../platform/runtime", () => ({ useNativeRuntime: () => ({ ready: true }) }));
vi.mock("../../../platform/git", () => ({ gitPush: vi.fn(), gitPull: vi.fn(), ghPrMarkReady: vi.fn(), gitErrorDescription: vi.fn() }));
vi.mock("../../use-git-refresh-key", () => ({ triggerGitRefresh: vi.fn() }));
vi.mock("../../../features/settings/use-git-remote", () => ({ useGitRemote: () => "origin" }));
vi.mock("../../../state/use-projects", () => ({ notifyWorkspacesChanged: vi.fn() }));
vi.mock("../../pr/use-agent-working", () => ({ useWorkspaceAgentWorking: () => false }));
vi.mock("../../pr/use-send-to-active-chat", () => ({ useSendToActiveChat: () => vi.fn() }));
vi.mock("../../pr/use-open-review-tab", () => ({ useShowReviewTab: () => vi.fn() }));
vi.mock("../../pr/workspace-git-action-claims", () => ({ useWorkspaceGitActionClaim: () => null }));
vi.mock("../summary-git-status-data", () => ({
  useSummaryGitStatus: () => ({ git: { data: null, error: state.error }, pr: { data: null }, error: state.persistentError, refresh: vi.fn() }),
}));
vi.mock("../../pr/create-pr-button", () => ({
  CreatePrButton: () => React.createElement("button", null, "Create PR"),
}));

import { SummaryGitStatus } from "../summary-git-status";

it.each(["/personal/worktree", "/organizations/example/worktree"])("only offers GitHub PR creation in %s when a GitHub remote is known", path => {
  const workspace = { id: path, path, repoRoot: path, branch: "feature", baseBranch: "main", prNumber: null } as Workspace;
  const render = (originUrl: string | null) => renderToStaticMarkup(React.createElement(SummaryGitStatus, {
    workspace, originUrl, active: true, onNavigate: vi.fn(),
  }));
  for (const originUrl of [null, "", "https://gitlab.com/example/repo.git"]) {
    expect(render(originUrl)).toContain("Git status");
    expect(render(originUrl)).not.toContain("Create PR");
  }
  expect(render("git@github.com:example/repo.git")).toContain("Create PR");
});

it("does not paint a failed first read, but keeps a persistent failure actionable", () => {
  const workspace = { id: "local", path: "/personal/a", repoRoot: "/personal/a", branch: "feature", baseBranch: "main", prNumber: null } as Workspace;
  const render = () => renderToStaticMarkup(React.createElement(SummaryGitStatus, { workspace, originUrl: null, active: true, onNavigate: vi.fn() }));
  state.error = new Error("temporary Git read failure");
  expect(render()).not.toContain("Git status unavailable");
  expect(render()).not.toContain(">Retry<");
  state.persistentError = state.error;
  expect(render()).toContain("Git status unavailable");
  expect(render()).toContain(">Retry<");
});
