import { describe, expect, it } from "vitest";
import type { Project } from "../../state/projects-store";
import type { Workspace } from "../../platform/git";
import { nestChildWorkspaces, type SidebarWorkspaceItem } from "../sidebar-workspace-model";

const project = { id: "p", name: "repo", repoRoot: "/r" } as Project;
const item = (id: string, parentWorkspaceId?: string): SidebarWorkspaceItem => ({
  kind: "workspace", key: `workspace:${id}`, project,
  workspace: { id, parentWorkspaceId } as Workspace,
});
const ids = (items: SidebarWorkspaceItem[]) =>
  items.map((row) => row.kind === "workspace" ? `${row.workspace.id}:${row.depth ?? 0}:${row.childCount ?? 0}` : row.key);

describe("nestChildWorkspaces", () => {
  const rows = [item("c1", "a"), item("a"), item("b"), item("g1", "c1"), item("orphan", "gone")];

  it("hides child workspaces under a collapsed parent", () => {
    expect(ids(nestChildWorkspaces(rows, new Set()))).toEqual(["a:0:1", "b:0:0", "orphan:0:0"]);
  });

  it("lists expanded children right after their parent", () => {
    expect(ids(nestChildWorkspaces(rows, new Set(["a", "c1"])))).toEqual(["a:0:1", "c1:1:1", "g1:2:0", "b:0:0", "orphan:0:0"]);
  });

  it("leaves a list with no child workspaces unchanged", () => {
    const flat = [item("a"), item("b")];
    expect(nestChildWorkspaces(flat, new Set())).toEqual(flat);
  });
});
