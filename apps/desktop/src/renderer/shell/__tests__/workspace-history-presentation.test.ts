import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Workspace } from "../../platform/git";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "connected" }));
vi.mock("../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: undefined, error: new Error("temporary read failure"), loading: false, refreshing: false, refresh: () => {} }),
}));
import { WorkspaceHistoryBar } from "../workspace-history-bar";

it.each(["/personal/a", "/organization/a"])("retains missing-folder guidance without a transient recovery error in %s", path => {
  const html = renderToStaticMarkup(createElement(WorkspaceHistoryBar, {
    workspace: { id: path, path, repoRoot: path, present: false, archivedAt: null } as Workspace,
  }));
  expect(html).toContain("Workspace folder missing");
  expect(html).not.toContain("Couldn&#x27;t check workspace recovery");
  expect(html).not.toContain('role="alert"');
});
