import { beforeEach, describe, expect, it } from "vitest";

import type { DesignWorkspaceSnapshotWire } from "../../../native/git";
import {
  applyDesignWorkspaceRefreshVersion,
  designWorkspaceSnapshotCache,
  resetDesignWorkspaceCacheForTests,
  stabilizeDesignWorkspaceSnapshot,
} from "../design-workspace-cache";

function snapshot(
  frames: Array<{ file: string; x?: number }> = [{ file: "home.html" }],
): DesignWorkspaceSnapshotWire {
  return {
    protocolCapability: "c".repeat(64),
    frames: frames.map(({ file, x = 0 }, index) => ({
      file,
      title: file.replace(".html", ""),
      width: 1440,
      height: 900,
      x,
      y: 0,
      z: index,
      nodeCount: 1,
      modifiedAt: 10,
      sourceVersion: `${index}`.padStart(24, "0"),
      source: `<!doctype html><body data-oid="${file}"></body>`,
      srcDoc: `<!doctype html><body data-oid="${file}"></body>`,
      tree: [
        {
          tag: "html",
          oid: file,
          text: null,
          children: [],
        },
      ],
    })),
    tokens: [
      {
        name: "--accent",
        syntax: "<color>",
        inherits: true,
        initialValue: "blue",
        value: "blue",
        themeValues: { dark: "deepskyblue" },
        usageCount: 1,
        line: 1,
      },
    ],
    tokenSourceVersion: "tokens-generation-000001",
    assets: [
      {
        path: "assets/mark.png",
        name: "mark.png",
        mimeType: "image/png",
        size: 4,
        modifiedAt: 10,
        dataUrl: "data:image/png;base64,iVBORw==",
      },
    ],
    lint: {
      workspacePath: "/work/design",
      checkedFiles: frames.map((frame) => frame.file),
      violations: [],
      healedOids: 0,
    },
  };
}

describe("design workspace cache", () => {
  beforeEach(() => {
    resetDesignWorkspaceCacheForTests();
  });

  it("reuses the complete snapshot when an aggregate refresh is equal", () => {
    const previous = snapshot();
    const stable = stabilizeDesignWorkspaceSnapshot(previous, snapshot());
    expect(stable).toBe(previous);
  });

  it("replaces only the changed frame and retains every unaffected collection", () => {
    const previous = snapshot([
      { file: "home.html" },
      { file: "pricing.html" },
    ]);
    const next = snapshot([
      { file: "home.html", x: 40 },
      { file: "pricing.html" },
    ]);

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable).not.toBe(previous);
    expect(stable.frames[0]).not.toBe(previous.frames[0]);
    expect(stable.frames[1]).toBe(previous.frames[1]);
    expect(stable.tokens).toBe(previous.tokens);
    expect(stable.assets).toBe(previous.assets);
    expect(stable.lint).toBe(previous.lint);
  });

  it("does not reuse a frame from another rendered source generation", () => {
    const previous = snapshot();
    const next = snapshot();
    next.frames[0] = {
      ...next.frames[0]!,
      sourceVersion: "ffffffffffffffffffffffff",
    };

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable.frames[0]).not.toBe(previous.frames[0]);
    expect(stable.frames[0]?.sourceVersion).toBe("ffffffffffffffffffffffff");
  });

  it("does not reuse a snapshot from another protocol capability generation", () => {
    const previous = snapshot();
    const next = snapshot();
    next.protocolCapability = "d".repeat(64);

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable).not.toBe(previous);
    expect(stable.frames).toBe(previous.frames);
    expect(stable.protocolCapability).toBe("d".repeat(64));
  });

  it("does not reuse tokens from another token source generation or theme value", () => {
    const previous = snapshot();
    const next = snapshot();
    next.tokenSourceVersion = "tokens-generation-000002";
    next.tokens[0] = {
      ...next.tokens[0]!,
      themeValues: { dark: "cyan" },
    };

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable).not.toBe(previous);
    expect(stable.tokens[0]).not.toBe(previous.tokens[0]);
    expect(stable.tokenSourceVersion).toBe("tokens-generation-000002");
  });

  it("coalesces sibling observers of one refresh generation", () => {
    designWorkspaceSnapshotCache.setData("ws_design", snapshot());
    const initial =
      designWorkspaceSnapshotCache.getSnapshot("ws_design").invalidationVersion;

    applyDesignWorkspaceRefreshVersion("ws_design", 4);
    applyDesignWorkspaceRefreshVersion("ws_design", 4);
    expect(
      designWorkspaceSnapshotCache.getSnapshot("ws_design").invalidationVersion,
    ).toBe(initial);

    applyDesignWorkspaceRefreshVersion("ws_design", 5);
    applyDesignWorkspaceRefreshVersion("ws_design", 5);
    expect(
      designWorkspaceSnapshotCache.getSnapshot("ws_design").invalidationVersion,
    ).toBe(initial + 1);
  });
});
