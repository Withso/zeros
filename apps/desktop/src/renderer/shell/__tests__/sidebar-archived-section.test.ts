import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const archive = vi.hoisted(() => ({ value: { workspaces: [] as unknown[], resolved: true } }));
vi.mock("../../state/use-projects", () => ({ useArchivedWorkspaces: () => archive.value }));
vi.mock("../../state/use-open-workspace", () => ({ useOpenWorkspace: () => () => {} }));
vi.mock("../../state/archive-actions", () => ({ restoreWorkspaceWithFeedback: vi.fn() }));
vi.mock("../../features/team/organization-capabilities", () => ({
  filterRowsForOrganization: (rows: unknown[]) => rows,
}));

import { SidebarArchivedSection } from "../sidebar-archived-section";

const render = (variant: "section" | "group") =>
  renderToStaticMarkup(createElement(SidebarArchivedSection, {
    variant,
    organization: null as never,
    collapsed: false,
    compact: false,
    onToggle: () => {},
  }));

beforeEach(() => {
  archive.value = { workspaces: [], resolved: true };
});

describe("the sidebar's Archived list", () => {
  // Group › Status drops an empty live group; Archived is one of its groups
  // and goes the same way once the archive list confirms it is empty.
  it("leaves Group › Status once it is confirmed empty", () => {
    expect(render("group")).toBe("");
    archive.value = { workspaces: [], resolved: false };
    expect(render("group")).toContain('data-sidebar-group="group:archived"');
  });

  it("keeps the View › Show archived section the user asked for", () => {
    expect(render("section")).toContain('data-sidebar-section="archived"');
  });

  it("shows a non-empty Archived group with its count", () => {
    archive.value = {
      workspaces: [{ id: "w", name: "old", path: "/w", branch: "old", archivedAt: 1, repoRoot: "/r" }],
      resolved: true,
    };
    expect(render("group")).toContain('aria-label="Archived, 1"');
  });
});
