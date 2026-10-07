import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  defaultId: "vscode",
  apps: [
    { id: "finder", name: "Finder", kind: "system", iconDataUrl: null },
    { id: "vscode", name: "Visual Studio Code", kind: "ide", iconDataUrl: null },
    { id: "terminal", name: "Terminal", kind: "system", iconDataUrl: null },
  ],
  open: vi.fn<(...args: string[]) => Promise<void>>(),
  setDefault: vi.fn<(id: string) => void>(),
  copy: vi.fn<(path: string) => Promise<void>>(),
  selections: [] as Array<() => void>,
  buttons: new Map<string, () => void>(),
}));

vi.mock("../../platform/open-apps", async importOriginal => ({
  ...await importOriginal<typeof import("../../platform/open-apps")>(),
  useDetectedOpenApps: () => fixture.apps,
  getDetectedOpenApps: () => fixture.apps,
  useOpenInDefaultId: () => fixture.defaultId,
  openPathWithApp: fixture.open,
  setOpenInDefaultId: fixture.setDefault,
}));
vi.mock("../../platform/app", async importOriginal => ({
  ...await importOriginal<typeof import("../../platform/app")>(),
  canOpenPathLocally: (path: string) => path.startsWith("/"),
}));
vi.mock("../../shared/ui", () => ({
  Button: ({ children, onClick, ...props }: { children: ReactNode; onClick?: () => void; "aria-label"?: string }) => {
    if (props["aria-label"] && onClick) fixture.buttons.set(props["aria-label"], onClick);
    return createElement("button", props, children);
  },
}));
vi.mock("../../shared/ui/primitives", async importOriginal => ({
  ...await importOriginal<typeof import("../../shared/ui/primitives")>(),
  Tooltip: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../shared/ui/primitives/dropdown-menu", () => {
  const passthrough = ({ children }: { children: ReactNode }) => createElement(Fragment, null, children);
  return {
    DropdownMenu: passthrough, DropdownMenuContent: passthrough, DropdownMenuTrigger: passthrough,
    DropdownMenuSub: passthrough, DropdownMenuSubContent: passthrough, DropdownMenuSubTrigger: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect: () => void; disabled?: boolean }) => {
      fixture.selections.push(onSelect);
      return createElement("button", { disabled }, children);
    },
  };
});

import { OpenInPathButton, OpenInSubmenu } from "../conversation/conversation-header";

beforeEach(() => {
  fixture.defaultId = "vscode";
  fixture.open.mockReset().mockResolvedValue(undefined);
  fixture.copy.mockReset().mockResolvedValue(undefined);
  fixture.setDefault.mockReset();
  fixture.selections = []; fixture.buttons.clear();
  vi.stubGlobal("navigator", { clipboard: { writeText: fixture.copy } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Local workspace and replica Open in targets", () => {
  it.each(["/Users/fixture/personal", "/Users/fixture/organization-local"])("keeps default-app and copy hints/actions for %s", path => {
    const html = renderToStaticMarkup(createElement(OpenInSubmenu, { path }));
    expect(html).toContain("⌘O"); expect(html).toContain("⌘C");
    for (const label of ["Finder", "Visual Studio Code", "Terminal", "Copy path"]) expect(html).toContain(label);
    fixture.selections[2]();
    expect(fixture.setDefault).toHaveBeenCalledWith("terminal");
    expect(fixture.open).toHaveBeenCalledWith("terminal", path);
    fixture.selections[3]();
    expect(fixture.copy).toHaveBeenCalledWith(path);
    expect(fixture.setDefault).toHaveBeenCalledTimes(1);
  });

  it("opens and copies the replica path without advertising workspace shortcuts", () => {
    const path = "/Users/fixture/downloaded-cloud";
    const html = renderToStaticMarkup(createElement(OpenInPathButton, { path }));
    expect(html).toContain(path);
    expect(html).not.toContain("⌘O"); expect(html).not.toContain("⌘C");
    fixture.buttons.get("Open sync directory in Visual Studio Code")!();
    expect(fixture.open).toHaveBeenCalledWith("vscode", path);
    expect(fixture.setDefault).not.toHaveBeenCalled();
    fixture.selections[0]();
    expect(fixture.open).toHaveBeenLastCalledWith("finder", path);
    expect(fixture.setDefault).toHaveBeenCalledWith("finder");
    fixture.selections[3]();
    expect(fixture.copy).toHaveBeenCalledWith(path);
  });
});
