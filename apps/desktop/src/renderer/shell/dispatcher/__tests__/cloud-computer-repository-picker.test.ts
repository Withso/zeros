import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  items: [] as (() => void)[],
  navigate: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("../../../state/store", () => ({
  useWorkspaceDispatch: () => state.dispatch,
}));
vi.mock("../../../features/settings/settings-navigation", () => ({
  requestUserSettingsSection: state.navigate,
}));
vi.mock("../../../shared/ui/primitives", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../shared/ui/primitives/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => createElement("h4", {}, children),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect: () => void;
  }) => {
    state.items.push(onSelect);
    return createElement("button", {}, children);
  },
}));
import { CloudComputerRepositoryPicker } from "../cloud-computer-repository-picker";

beforeEach(() => {
  state.items = [];
  state.navigate.mockReset();
  state.dispatch.mockReset();
});
describe("Cloud Computer project picker", () => {
  it("splits repositories into the organization's and Only you, and manages them in the GitHub page it is given", () => {
    const shared = { id: "withso/zeros", owner: "withso", name: "zeros", defaultBranch: "main", level: "shared" as const };
    const mine = { id: "withso/notes", owner: "withso", name: "notes", defaultBranch: null, level: "private" as const };
    const html = renderToStaticMarkup(createElement(CloudComputerRepositoryPicker, { repositories: [mine, shared], selected: shared, active: true, open: true,
      onOpenChange: vi.fn(), disabled: false, onSelect: vi.fn(), warm: vi.fn(), manage: true, organizationName: "Withso", manageSection: "org-github" }));
    const menu = html.slice(html.indexOf("<h4>"));
    const order = ["<h4>Withso</h4>", "withso/zeros", "<h4>Only you</h4>", "withso/notes", "Manage repositories"].map(part => menu.indexOf(part));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    state.items.at(-1)!();
    expect(state.navigate).toHaveBeenCalledWith("org-github");
  });

  it("renders active repository names and only the Add repository Settings action", () => {
    const repository = { id: "example/project", owner: "example", name: "project", defaultBranch: "main" };
    const select = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CloudComputerRepositoryPicker, {
        repositories: [repository],
        selected: repository,
        active: true,
        open: true,
        onOpenChange: vi.fn(),
        disabled: false,
        onSelect: select,
        warm: vi.fn(),
      }),
    );
    expect(html).toContain("example/project");
    expect(html).toContain("Add repository");
    for (const label of [
      "Open project",
      "Open GitHub project",
      "Start from scratch",
      "No projects yet",
    ])
      expect(html).not.toContain(label);
    state.items[0]();
    expect(select).toHaveBeenCalledWith("example/project");
    state.items[1]();
    expect(state.navigate).toHaveBeenCalledWith("cloud-computer");
    expect(state.dispatch).toHaveBeenCalledWith({
      type: "SET_ACTIVE_PAGE",
      page: "settings",
    });
  });
});

describe("the Manage repositories destination", () => {
  it("is the organization's Connections page for members and owners, else Integrations or the Cloud Computer", async () => {
    const { githubManageSection } = await import("../dispatcher-modal");
    expect(githubManageSection(false, { solo: false }, false)).toBe("cloud-computer");
    expect(githubManageSection(true, { solo: false }, false)).toBe("org-github");
    expect(githubManageSection(true, { solo: true }, false)).toBe("integrations");
    expect(githubManageSection(true, { solo: false }, true)).toBe("integrations");
    // Before the levels read answers, Integrations is the safe destination.
    expect(githubManageSection(true, null, false)).toBe("integrations");
  });
});
