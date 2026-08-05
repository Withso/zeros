import { afterEach, describe, expect, it } from "vitest";

import {
  forgetDesignSelection,
  getDesignSelection,
  setDesignSelection,
  type DesignSelection,
} from "../selection";

const WORKSPACE_ID = "workspace-selection-race";

function selection(frame: string, updatedAt: number): DesignSelection {
  return {
    frame,
    filePath: `Zeros Design/${frame}`,
    sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
    nodeIds: [],
    breadcrumb: [frame],
    rects: [{ x: 0, y: 0, width: 100, height: 80 }],
    keyComputedStyles: {},
    updatedAt,
  };
}

describe("design selection registry", () => {
  afterEach(() => forgetDesignSelection(WORKSPACE_ID));

  it("rejects an older publication that completes after the latest selection", () => {
    setDesignSelection(WORKSPACE_ID, selection("latest.html", 20), 20);
    setDesignSelection(WORKSPACE_ID, selection("stale.html", 10), 10);

    expect(getDesignSelection(WORKSPACE_ID)?.frame).toBe("latest.html");
  });

  it("keeps a newer clear authoritative over an older in-flight selection", () => {
    setDesignSelection(WORKSPACE_ID, selection("before-clear.html", 20), 20);
    setDesignSelection(WORKSPACE_ID, null, 30);
    setDesignSelection(WORKSPACE_ID, selection("stale.html", 25), 25);

    expect(getDesignSelection(WORKSPACE_ID)).toBeNull();
  });
});
