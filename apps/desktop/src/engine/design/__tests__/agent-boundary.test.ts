import { describe, expect, it } from "vitest";

import {
  filterDesignWorkspaceDirectories,
  isDesignWorkspaceTarget,
} from "../agent-boundary";

const workspaces = [
  {
    id: "ws_code",
    kind: "code" as const,
    path: "/Users/dev/zeros/workspaces/repo/code",
  },
  {
    id: "ws_design",
    kind: "design" as const,
    path: "/var/folders/design",
  },
];

describe("design coding-agent boundary", () => {
  it("recognizes an opaque id, exact path, descendant, and macOS /private alias", () => {
    expect(isDesignWorkspaceTarget("ws_design", workspaces)).toBe(true);
    expect(isDesignWorkspaceTarget("/var/folders/design", workspaces)).toBe(
      true,
    );
    expect(
      isDesignWorkspaceTarget("/var/folders/design/Zeros Design", workspaces),
    ).toBe(true);
    expect(
      isDesignWorkspaceTarget(
        "/private/var/folders/design/Zeros Design/frame.html",
        workspaces,
      ),
    ).toBe(true);
  });

  it("does not confuse code workspaces, siblings, or arbitrary folders", () => {
    expect(isDesignWorkspaceTarget("ws_code", workspaces)).toBe(false);
    expect(
      isDesignWorkspaceTarget(
        "/Users/dev/zeros/workspaces/repo/code/src",
        workspaces,
      ),
    ).toBe(false);
    expect(isDesignWorkspaceTarget("/var/folders/design-old", workspaces)).toBe(
      false,
    );
    expect(isDesignWorkspaceTarget("/tmp/plain", workspaces)).toBe(false);
  });

  it("removes Design roots from additional directories without changing code paths", () => {
    expect(
      filterDesignWorkspaceDirectories(
        [
          "/work/api",
          "/var/folders/design",
          "/var/folders/design/Zeros Design",
          "/work/web",
        ],
        workspaces,
      ),
    ).toEqual(["/work/api", "/work/web"]);
  });
});
