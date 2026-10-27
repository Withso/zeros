import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("../../../platform/bridge/use-bridge", () => ({ useBridge: () => null, useBridgeStatus: () => "connected" }));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: undefined, error: new Error("temporary read failure"), loading: false, refreshing: false, refresh: () => {} }),
}));
// Render the menu's content in this presentation test without opening a portal.
vi.mock("../../../shared/ui/primitives/dropdown-menu", () => {
  const content = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  return { DropdownMenu: content, DropdownMenuContent: content, DropdownMenuItem: content, DropdownMenuTrigger: content };
});
import { DesignDirectoryMenu } from "../design-directory-menu";
import { DesignWorkspaceSidebarPanels } from "../design-workspace-sidebar-panels";

it.each(["/personal/design", "/organization/design"])("does not flash a directory error in %s", path => {
  const workspace = { id: path, path, repoRoot: path } as Workspace;
  const menu = renderToStaticMarkup(React.createElement(DesignDirectoryMenu, { workspace, active: true, name: "Design" }));
  expect(menu).not.toContain("load directories");
});
it.each(["/personal/design", "/organization/design"])("does not flash a layers error in %s", path => {
  const workspace = { id: path, path, repoRoot: path } as Workspace;
  const layers = renderToStaticMarkup(React.createElement(DesignWorkspaceSidebarPanels, { workspace, folder: path, surfaceActive: true }));
  expect(layers).not.toContain("Couldn’t load layers");
});
