import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { RepoBranchCatalog, Workspace } from "../../../platform/git";
import { createBranchCatalogCache } from "../../../state/read-caches";
import { PrStatusRow } from "../pr-status-row";

const fixture = vi.hoisted(() => ({ ready: true, changes: true, notice: vi.fn(() => null), document: undefined as { status: string; capabilities: { githubPullRequests?: number }; githubUnavailableReason?: string } | undefined, changesProbe: vi.fn() }));
vi.mock("../../../platform/runtime", () => ({ useNativeRuntime: () => ({ ready: fixture.ready }) }));
vi.mock("../use-workspace-has-changes", () => ({ useWorkspaceHasChanges: (...args: unknown[]) => { fixture.changesProbe(...args); return fixture.changes; } }));
vi.mock("../../../platform/use-cloud-github-pr", () => ({ useCloudGithubPrDocument: () => fixture.document }));
vi.mock("../cloud-history-notice", () => ({ CloudHistoryNotice: fixture.notice }));
vi.mock("../pr-status-island", () => ({ PrStatusIsland: ({ workspace }: { workspace: Workspace }) => React.createElement("span", null, `PR ${workspace.prNumber}`) }));
vi.mock("../target-branch-select", () => ({ TargetBranchButton: ({ disabled }: { disabled: boolean }) => React.createElement("button", { disabled }, "Target") }));
vi.mock("../create-pr-button", () => ({ CreatePrButton: ({ disabled }: { disabled: boolean }) => React.createElement("button", { disabled }, "Create PR") }));

beforeEach(() => { vi.clearAllMocks(); createBranchCatalogCache.clear(); fixture.ready = true; fixture.changes = true; fixture.document = undefined; });
const workspace = { id: "local-worktree", path: "/worktree", placement: "local", prNumber: null } as Workspace;
const render = (overrides: Partial<Workspace> = {}, originUrl: string | null = "https://github.com/example/repo.git") => renderToStaticMarkup(
  React.createElement(PrStatusRow, { workspace: { ...workspace, ...overrides }, originUrl, active: true }),
);

it.each([null, "", "https://gitlab.com/example/repo.git"])("keeps the local target branch without PR creation for remote %s", originUrl => {
  for (const path of ["/local/worktree", "/organizations/example/worktree"]) {
    const html = render({ path }, originUrl);
    expect(html).toContain("<button>Target</button>");
    expect(html).not.toContain("Create PR");
  }
});

it("keeps PR creation for a configured GitHub remote without an origin", () => {
  const repoRoot = "/repo";
  createBranchCatalogCache.setData(JSON.stringify([repoRoot, null]), {
    effectiveRemote: "upstream",
    remotes: [{ name: "upstream", url: "git@github.com:example/repo.git", isGitHub: true }],
  } as RepoBranchCatalog);
  expect(render({ repoRoot }, null)).toContain("Create PR");
});

it("keeps Local target/Create PR controls and disabled states without mounting cloud history", () => {
  expect(render()).toContain('<button>Target</button><div class="flex-1"></div><button>Create PR</button>');
  fixture.changes = false;
  expect(render()).toContain('<button disabled="">Create PR</button>');
  fixture.ready = false;
  const offline = render();
  expect(offline).toContain('<button disabled="">Target</button>');
  expect(offline).not.toContain("Create PR");
  expect(fixture.notice).not.toHaveBeenCalled();
});

it("keeps the Local PR island exclusive and never mounts the cloud history reader", () => {
  expect(render({ prNumber: 42 })).toBe("<span>PR 42</span>");
  expect(fixture.notice).not.toHaveBeenCalled();
});

it("keeps the cloud target branch but offers no PR island or creation until cloud serves pull requests", () => {
  const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  fixture.document = { status: "ready", capabilities: {} };
  for (const prNumber of [null, 7]) {
    const html = render({ id: cloud, path: cloud, placement: "cloud", prNumber });
    expect(html).toContain("<button>Target</button>");
    expect(html).toContain("Pull requests aren&#x27;t available for this cloud workspace.");
    expect(html).not.toContain("Create PR");
    expect(html).not.toContain("PR 7");
  }
});


it("shows cloud PR status without a Local engine and never probes a stopped checkout", () => {
  const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  fixture.ready = false;
  fixture.document = { status: "stopped", capabilities: { githubPullRequests: 1 } };
  expect(render({ id: cloud, path: cloud, placement: "cloud", prNumber: 7 })).toBe("<span>PR 7</span>");
  expect(fixture.changesProbe.mock.calls.at(-1)?.[1]).toBe(false);
  expect(render({ id: cloud, path: cloud, placement: "cloud" })).toContain('<button disabled="">Create PR</button>');
  fixture.document.status = "ready";
  expect(render({ id: cloud, path: cloud, placement: "cloud" })).toContain('<button>Create PR</button>');
});

it.each([
  ["connection-required", "Connect GitHub in Settings"],
  ["connection-expired", "Reconnect GitHub in Settings"],
  ["installation-required", "Grant the Zeros GitHub App access"],
  ["access-denied", "selected GitHub connection cannot access"],
  ["source-review-required", "source access verified"],
])("explains cloud GitHub unavailability for %s while withholding stale PR metadata", (reason, copy) => {
  const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  fixture.document = { status: "stopped", capabilities: {}, githubUnavailableReason: reason };
  const html = render({ id: cloud, path: cloud, placement: "cloud", prNumber: 7 });
  expect(html).toContain(copy);
  expect(html).not.toContain("PR 7");
  expect(html).not.toContain("Create PR");
});
