import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  nextWorkbenchColumnState,
  onWorkbenchCollapseRequest,
  onWorkbenchRestoreRequest,
  persistedWorkbenchCollapsed,
  requestWorkbenchCollapse,
  requestWorkbenchRestore,
  type WorkbenchColumnEvent,
  type WorkbenchColumnState,
} from "../workbench-visibility-controller";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
}

const OPEN: WorkbenchColumnState = { collapsed: false, hiddenByFloat: false };
const HIDDEN_BY_USER: WorkbenchColumnState = { collapsed: true, hiddenByFloat: false };
const run = (state: WorkbenchColumnState, ...events: WorkbenchColumnEvent[]) =>
  events.reduce(
    (current, event) => nextWorkbenchColumnState(current, event),
    state,
  );

describe("workbench collapse requests", () => {
  it("notifies every mounted shell until it unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onWorkbenchCollapseRequest(first);
    const stopSecond = onWorkbenchCollapseRequest(second);
    requestWorkbenchCollapse();
    stopFirst();
    requestWorkbenchCollapse();
    stopSecond();
    requestWorkbenchCollapse();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("notifies restore listeners separately from collapse listeners", () => {
    const collapse = vi.fn();
    const restore = vi.fn();
    const stopCollapse = onWorkbenchCollapseRequest(collapse);
    const stopRestore = onWorkbenchRestoreRequest(restore);
    requestWorkbenchRestore();
    stopRestore();
    requestWorkbenchRestore();
    stopCollapse();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(collapse).not.toHaveBeenCalled();
  });

  it("collapses the column only when a tab starts floating", () => {
    const toggle = body(
      read("apps/desktop/src/renderer/shell/workbench/tabs/browser-tab.tsx"),
      "const toggleFloat = () => {",
      "\n  };\n",
    );
    const dock = toggle.indexOf("dockBrowserTab(floatKey)");
    const earlyReturn = toggle.indexOf("return;", dock);
    const float = toggle.indexOf("floatBrowserTab({");
    const collapse = toggle.indexOf("requestWorkbenchCollapse();");
    expect(dock).toBeGreaterThan(0);
    expect(earlyReturn).toBeGreaterThan(dock);
    expect(float).toBeGreaterThan(earlyReturn);
    expect(collapse).toBeGreaterThan(float);
  });

  it("lets the shell change the column only while workspace tools are available", () => {
    const shell = read("apps/desktop/src/renderer/app-shell.tsx");
    const update = body(
      shell,
      "const updateWorkbenchColumn = React.useCallback(",
      "[workspaceToolsAvailable],",
    );
    expect(update).toContain("if (!workspaceToolsAvailable) return;");
    expect(update).toContain("nextWorkbenchColumnState(previous, event)");
    expect(update).toContain(
      "setSetting(WORKBENCH_COLLAPSED_KEY, persistedWorkbenchCollapsed(next));",
    );
    expect(shell).toContain(
      'onWorkbenchCollapseRequest(() => updateWorkbenchColumn("float"))',
    );
    expect(shell).toContain(
      'onWorkbenchRestoreRequest(() => updateWorkbenchColumn("floats-closed"))',
    );
    // "Open in right panel" on a float docks the tab and reveals the column.
    const stack = read("apps/desktop/src/renderer/features/browser/browser-float-stack.tsx");
    const openInPanel = body(stack, "const openInPanel = () => {", "\n  };\n");
    expect(openInPanel).toContain("dockBrowserTab(entry.key);");
    expect(openInPanel).toContain("onRevealWorkbench();");
  });

  it("asks for the column back when Close ends the scope's last float", () => {
    const stack = read("apps/desktop/src/renderer/features/browser/browser-float-stack.tsx");
    const close = body(stack, "const closeFloat = () => {", "\n  };\n");
    expect(close).toContain("if (closeBrowserFloat(entry.key)) requestWorkbenchRestore();");
    expect(stack).toContain("onClick={closeFloat}");
  });
});

describe("workbench column state", () => {
  it("brings back a column a float hid once the last float closes", () => {
    const floating = run(OPEN, "float");
    expect(floating).toEqual({ collapsed: true, hiddenByFloat: true });
    expect(run(floating, "float", "floats-closed")).toEqual(OPEN);
  });

  it("leaves a column the user hid hidden after the float closes", () => {
    expect(run(HIDDEN_BY_USER, "float")).toBe(HIDDEN_BY_USER);
    expect(run(HIDDEN_BY_USER, "float", "floats-closed")).toBe(HIDDEN_BY_USER);
  });

  it("keeps a choice the user made while a float was open", () => {
    expect(run(OPEN, "float", "toggle", "toggle", "floats-closed")).toEqual(
      HIDDEN_BY_USER,
    );
    expect(run(OPEN, "float", "toggle", "floats-closed")).toEqual(OPEN);
    expect(run(OPEN, "float", "reveal", "floats-closed")).toEqual(OPEN);
  });

  it("changes nothing when there is nothing to restore or reveal", () => {
    expect(run(OPEN, "floats-closed")).toBe(OPEN);
    expect(run(OPEN, "reveal")).toBe(OPEN);
    expect(run(HIDDEN_BY_USER, "floats-closed")).toBe(HIDDEN_BY_USER);
  });

  it("persists the user's choice, never a float's temporary hide", () => {
    expect(persistedWorkbenchCollapsed(run(OPEN, "float"))).toBe(false);
    expect(persistedWorkbenchCollapsed(run(OPEN, "toggle"))).toBe(true);
    expect(persistedWorkbenchCollapsed(run(OPEN, "float", "toggle", "toggle"))).toBe(true);
    expect(persistedWorkbenchCollapsed(run(HIDDEN_BY_USER, "float"))).toBe(true);
  });
});
