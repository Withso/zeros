import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";
import type { SummaryGitFacts } from "../summary-git-status-model";

const state = vi.hoisted(() => ({
  error: null as Error | null, persistentError: null as Error | null,
  readError: null as Error | null, connected: true,
  facts: undefined as SummaryGitFacts | undefined, refreshing: false,
}));
afterEach(() => {
  state.error = state.persistentError = state.readError = null;
  state.connected = true;
  state.facts = undefined;
  state.refreshing = false;
});

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
  useSummaryGitStatus: () => ({
    git: { data: state.facts, error: state.error, refreshing: state.refreshing },
    pr: { data: null }, error: state.persistentError, readError: state.readError,
    connected: state.connected, refresh: vi.fn(),
  }),
}));
vi.mock("../../pr/create-pr-button", () => ({
  CreatePrButton: ({ disabled }: { disabled: boolean }) => React.createElement("button", { disabled, "aria-label": "Create PR" }, "Create PR"),
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

it.each(["/personal/worktree", "/organizations/example/worktree"])("keeps mutations guarded through quiet recovery in %s", path => {
  const workspace = { id: path, path, repoRoot: path, branch: "feature", baseBranch: "main", prNumber: null } as Workspace;
  state.facts = { all: 2, uncommitted: 1, conflicted: 0, operation: null, ahead: 1, behind: 0, upstream: "origin/feature", branch: "feature" };
  const render = () => renderToStaticMarkup(React.createElement(SummaryGitStatus, {
    workspace, originUrl: "git@github.com:example/repo.git", active: true, onNavigate: vi.fn(),
  }));
  const expectActions = (disabled: boolean) => {
    const html = render();
    for (const label of ["Create PR", "Commit and push", "Push"]) {
      const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
      expect(button).toBeDefined();
      expect(button?.includes('disabled=""')).toBe(disabled);
    }
    expect(html).not.toContain("Git status unavailable");
  };
  // Ordinary revalidation keeps confirmed data usable.
  state.refreshing = true;
  expectActions(false);
  // The retry has cleared git.error, but has not replaced the failed read.
  state.readError = new Error("temporary Git read failure");
  expectActions(true);
  state.readError = null;
  state.refreshing = false;
  expectActions(false);
  state.connected = false;
  expectActions(true);
});
