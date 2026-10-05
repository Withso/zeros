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
  it("renders active repository names and only the Add repository Settings action", () => {
    const repository = {
      id: "123",
      owner: "example",
      name: "project",
      installationId: "11111111-1111-4111-8111-111111111111",
    };
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
    expect(select).toHaveBeenCalledWith("123");
    state.items[1]();
    expect(state.navigate).toHaveBeenCalledWith("cloud-computer");
    expect(state.dispatch).toHaveBeenCalledWith({
      type: "SET_ACTIVE_PAGE",
      page: "settings",
    });
  });
});
