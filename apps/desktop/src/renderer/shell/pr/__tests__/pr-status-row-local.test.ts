import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";
import { PrStatusRow } from "../pr-status-row";

const fixture = vi.hoisted(() => ({ ready: true, changes: true, notice: vi.fn(() => null) }));
vi.mock("../../../platform/runtime", () => ({ useNativeRuntime: () => ({ ready: fixture.ready }) }));
vi.mock("../use-workspace-has-changes", () => ({ useWorkspaceHasChanges: () => fixture.changes }));
vi.mock("../cloud-history-notice", () => ({ CloudHistoryNotice: fixture.notice }));
vi.mock("../pr-status-island", () => ({ PrStatusIsland: ({ workspace }: { workspace: Workspace }) => React.createElement("span", null, `PR ${workspace.prNumber}`) }));
vi.mock("../target-branch-select", () => ({ TargetBranchButton: ({ disabled }: { disabled: boolean }) => React.createElement("button", { disabled }, "Target") }));
vi.mock("../create-pr-button", () => ({ CreatePrButton: ({ disabled }: { disabled: boolean }) => React.createElement("button", { disabled }, "Create PR") }));

beforeEach(() => { vi.clearAllMocks(); fixture.ready = true; fixture.changes = true; });
const workspace = { id: "local-worktree", path: "/worktree", placement: "local", prNumber: null } as Workspace;
const render = (overrides: Partial<Workspace> = {}) => renderToStaticMarkup(
  React.createElement(PrStatusRow, { workspace: { ...workspace, ...overrides }, originUrl: "https://github.com/example/repo.git", active: true }),
);

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
  for (const prNumber of [null, 7]) {
    const html = render({ id: cloud, path: cloud, placement: "cloud", prNumber });
    expect(html).toContain("<button>Target</button>");
    expect(html).toContain("Pull requests aren&#x27;t available in cloud workspaces yet.");
    expect(html).not.toContain("Create PR");
    expect(html).not.toContain("PR 7");
  }
});
