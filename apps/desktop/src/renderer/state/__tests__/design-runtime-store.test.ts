import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeScreenshot,
  DesignRuntimeSnapshot,
} from "@zeros/protocol/design-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  designRuntimeFrameState,
  forgetDesignRuntimeWorkspace,
  resetDesignRuntimeStoreForTests,
  useDesignRuntimeStore,
} from "../../features/design-workspace/state/design-runtime-store";

function details(
  oid: string,
  sourceVersion = "aaaaaaaaaaaaaaaaaaaaaaaa",
): DesignRuntimeNodeDetails {
  return {
    sourceVersion,
    oid,
    tag: "h1",
    name: oid,
    text: "Hello",
    selector: `[data-oid="${oid}"]`,
    visible: true,
    breadcrumb: [`h1 · ${oid}`],
    rect: { x: 1, y: 2, width: 30, height: 10 },
    styles: { fontSize: "32px" },
  };
}

function snapshot(
  revision: number,
  sourceVersion = "aaaaaaaaaaaaaaaaaaaaaaaa",
): DesignRuntimeSnapshot {
  return {
    sourceVersion,
    revision,
    tree: [],
    warnings: [],
    frame: details("frame", sourceVersion),
    viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
  };
}

function screenshot(
  nodeId: string | null,
  sourceVersion = "aaaaaaaaaaaaaaaaaaaaaaaa",
): DesignRuntimeScreenshot {
  return {
    sourceVersion,
    nodeId,
    dataUrl: "data:image/png;base64,cGl4ZWxz",
    mimeType: "image/png",
    width: 100,
    height: 80,
    scale: 1,
  };
}

describe("live design runtime cache", () => {
  beforeEach(() => {
    resetDesignRuntimeStoreForTests();
    vi.restoreAllMocks();
  });

  it("isolates frame/node readback by exact workspace key", () => {
    const store = useDesignRuntimeStore.getState();
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      snapshot(1),
      "aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    store.publishSnapshot(
      "workspace-b",
      "/design/b",
      "home.html",
      snapshot(2, "bbbbbbbbbbbbbbbbbbbbbbbb"),
      "bbbbbbbbbbbbbbbbbbbbbbbb",
    );
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      details("hero"),
      "aaaaaaaaaaaaaaaaaaaaaaaa",
    );

    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.snapshot?.revision,
    ).toBe(1);
    expect(
      designRuntimeFrameState("workspace-b", "home.html")?.snapshot?.revision,
    ).toBe(2);
    expect(
      designRuntimeFrameState("workspace-b", "home.html")?.detailsByNode.hero,
    ).toBeUndefined();
    expect(
      useDesignRuntimeStore.getState().workspaceIdByFolder["/design/a"],
    ).toBe("workspace-a");
  });

  it("bounds inactive frames and prunes a permanently removed owner", () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const store = useDesignRuntimeStore.getState();
    for (let index = 0; index < 28; index += 1) {
      const sourceVersion = index.toString(16).padStart(24, "0");
      store.publishSnapshot(
        "workspace-a",
        "/design/a",
        `frame-${index}.html`,
        snapshot(index, sourceVersion),
        sourceVersion,
      );
    }

    expect(
      Object.keys(
        useDesignRuntimeStore.getState().byWorkspace["workspace-a"]?.frames ??
          {},
      ),
    ).toHaveLength(24);
    expect(
      designRuntimeFrameState("workspace-a", "frame-0.html"),
    ).toBeUndefined();
    expect(
      designRuntimeFrameState("workspace-a", "frame-27.html"),
    ).toBeDefined();

    forgetDesignRuntimeWorkspace("workspace-a");
    expect(
      useDesignRuntimeStore.getState().workspaceIdByFolder["/design/a"],
    ).toBeUndefined();
  });

  it("retains last confirmed readback while a new source generation revalidates", () => {
    const store = useDesignRuntimeStore.getState();
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      snapshot(1),
      "aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      details("hero"),
      "aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    store.publishScreenshot(
      "workspace-a",
      "/design/a",
      "home.html",
      screenshot("hero"),
      "aaaaaaaaaaaaaaaaaaaaaaaa",
    );

    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      snapshot(2),
      "aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode.hero,
    ).toBeDefined();
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.screenshotsByNode
        .hero,
    ).toBeDefined();

    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      snapshot(1, "bbbbbbbbbbbbbbbbbbbbbbbb"),
      "bbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(designRuntimeFrameState("workspace-a", "home.html")).toMatchObject({
      sourceVersion: "bbbbbbbbbbbbbbbbbbbbbbbb",
      detailsByNode: {
        hero: expect.objectContaining({
          sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      },
      screenshotsByNode: {
        hero: expect.objectContaining({
          sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      },
    });
  });
});
