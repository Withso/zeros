import { describe, expect, it } from "vitest";

import { buildDirectFileOpenAction } from "../direct-file-open";
import type { Column3Tab } from "../column3-tab-manager";

const file = (
  id: string,
  filePath?: string,
  fileTreeVisible = true,
  fixed = false,
): Column3Tab => ({
  id,
  type: "files",
  title: filePath?.split("/").at(-1) ?? "Open file",
  filePath,
  fileTreeVisible,
  ...(fixed ? { fixed: true } : {}),
});

describe("buildDirectFileOpenAction", () => {
  it.each([
    ["expanded extra", file("extra", "src/mcp/tools.ts", true)],
    ["collapsed extra", file("extra", "src/mcp/tools.ts", false)],
    ["expanded fixed", file("home", "src/mcp/tools.ts", true, true)],
    ["collapsed fixed", file("home", "src/mcp/tools.ts", false, true)],
  ])(
    "focuses an existing %s tab without rewriting its tree state",
    (_label, tab) => {
      expect(buildDirectFileOpenAction([tab], "src/mcp/tools.ts")).toEqual({
        type: "ACTIVATE_COLUMN3_TAB",
        id: tab.id,
      });
    },
  );

  it("fills an existing blank tab without collapsing its expanded tree", () => {
    const home = file("home", undefined, true, true);

    expect(buildDirectFileOpenAction([home], "src/mcp/tools.ts")).toEqual({
      type: "OPEN_COLUMN3_TAB",
      id: home.id,
      updates: {
        filePath: "src/mcp/tools.ts",
        title: "tools.ts",
        viewerMode: undefined,
      },
    });
  });

  it("prefers the active blank for quick-open without changing its tree choice", () => {
    const home = file("home", undefined, true, true);
    const activeBlank = file("extra", undefined, true);

    expect(
      buildDirectFileOpenAction([home, activeBlank], "src/mcp/tools.ts", {
        preferredBlankId: activeBlank.id,
      }),
    ).toMatchObject({
      type: "OPEN_COLUMN3_TAB",
      id: activeBlank.id,
      updates: { filePath: "src/mcp/tools.ts" },
    });
    expect(
      buildDirectFileOpenAction([home, activeBlank], "src/mcp/tools.ts", {
        preferredBlankId: activeBlank.id,
      }),
    ).not.toHaveProperty("updates.fileTreeVisible");
  });

  it("keeps the active duplicate instead of jumping to an earlier matching tab", () => {
    const fixedDuplicate = file("home", "src/mcp/tools.ts", true, true);
    const activeDuplicate = file("extra", "src/mcp/tools.ts", false);

    expect(
      buildDirectFileOpenAction(
        [fixedDuplicate, activeDuplicate],
        "src/mcp/tools.ts",
        { preferredExistingTabId: activeDuplicate.id },
      ),
    ).toEqual({ type: "ACTIVATE_COLUMN3_TAB", id: activeDuplicate.id });
  });

  it("collapses only a newly allocated File tab", () => {
    const action = buildDirectFileOpenAction([], "src/mcp/tools.ts");

    expect(action).toMatchObject({
      type: "ADD_COLUMN3_TAB",
      tab: {
        type: "files",
        filePath: "src/mcp/tools.ts",
        fileTreeVisible: false,
      },
    });
  });

  it("carries the exact workspace through every transition kind", () => {
    const scope = "/repo/worktree-a";
    const existing = file("existing", "src/mcp/tools.ts", true, true);
    const blank = file("blank", undefined, true, true);

    expect(
      buildDirectFileOpenAction([existing], "src/mcp/tools.ts", { scope }),
    ).toEqual({
      type: "ACTIVATE_COLUMN3_TAB",
      id: existing.id,
      scope,
    });
    expect(
      buildDirectFileOpenAction([blank], "src/mcp/tools.ts", { scope }),
    ).toMatchObject({ type: "OPEN_COLUMN3_TAB", id: blank.id, scope });
    expect(
      buildDirectFileOpenAction([], "src/mcp/tools.ts", { scope }),
    ).toMatchObject({ type: "ADD_COLUMN3_TAB", scope });
  });
});
