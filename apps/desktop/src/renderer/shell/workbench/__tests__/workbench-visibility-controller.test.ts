import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  onWorkbenchCollapseRequest,
  requestWorkbenchCollapse,
} from "../workbench-visibility-controller";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
}

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

  it("lets the shell persist the collapse only while workspace tools are available", () => {
    const shell = read("apps/desktop/src/renderer/app-shell.tsx");
    const collapse = body(shell, "const collapseWorkbench = React.useCallback(", "}, [workspaceToolsAvailable]);");
    expect(collapse).toContain("if (!workspaceToolsAvailable) return;");
    expect(collapse).toContain("setSetting(WORKBENCH_COLLAPSED_KEY, true);");
    expect(shell).toContain("onWorkbenchCollapseRequest(collapseWorkbench)");
    // "Open in right panel" on a float docks the tab and reveals the column.
    const stack = read("apps/desktop/src/renderer/features/browser/browser-float-stack.tsx");
    const openInPanel = body(stack, "const openInPanel = () => {", "\n  };\n");
    expect(openInPanel).toContain("dockBrowserTab(entry.key);");
    expect(openInPanel).toContain("onRevealWorkbench();");
  });
});
