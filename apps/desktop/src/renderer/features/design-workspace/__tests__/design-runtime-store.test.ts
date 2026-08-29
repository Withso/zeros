import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { beforeEach, describe, expect, it } from "vitest";

import {
  designRuntimeFrameState,
  resetDesignRuntimeStoreForTests,
  useDesignRuntimeStore,
} from "../state/design-runtime-store";

const SOURCE_VERSION = "1".repeat(24);
const NEXT_SOURCE_VERSION = "2".repeat(24);

function details(): DesignRuntimeNodeDetails {
  return {
    sourceVersion: SOURCE_VERSION,
    oid: "heading",
    tag: "h1",
    name: "Heading",
    text: "Hello",
    textEditable: true,
    selector: '[data-oid="heading"]',
    visible: true,
    breadcrumb: ["main · Hero", "h1 · Heading"],
    rect: { x: 10, y: 20, width: 100, height: 40 },
    styles: { left: "10px", top: "20px" },
    authoredStyleProperties: ["left", "top"],
  };
}

describe("design runtime store", () => {
  beforeEach(() => resetDesignRuntimeStoreForTests());

  it("does not notify subscribers for an identical runtime snapshot", () => {
    const currentDetails = details();
    const snapshot = {
      sourceVersion: SOURCE_VERSION,
      revision: 1,
      tree: [],
      frame: { ...currentDetails, oid: "" },
      warnings: [],
      viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
    };
    let notifications = 0;
    const unsubscribe = useDesignRuntimeStore.subscribe(() => {
      notifications += 1;
    });

    const store = useDesignRuntimeStore.getState();
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      snapshot,
      SOURCE_VERSION,
    );
    const firstFrame = designRuntimeFrameState("workspace-a", "home.html");
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      snapshot,
      SOURCE_VERSION,
    );
    unsubscribe();

    expect(notifications).toBe(1);
    expect(designRuntimeFrameState("workspace-a", "home.html")).toBe(
      firstFrame,
    );
  });

  it("reuses semantically equal node details without notifying subscribers", () => {
    let notifications = 0;
    const unsubscribe = useDesignRuntimeStore.subscribe(() => {
      notifications += 1;
    });

    useDesignRuntimeStore
      .getState()
      .publishNodeDetails(
        "workspace-a",
        "/design/a",
        "home.html",
        details(),
        SOURCE_VERSION,
      );
    const first = designRuntimeFrameState("workspace-a", "home.html")
      ?.detailsByNode.heading;
    useDesignRuntimeStore
      .getState()
      .publishNodeDetails(
        "workspace-a",
        "/design/a",
        "home.html",
        details(),
        SOURCE_VERSION,
      );
    unsubscribe();

    expect(notifications).toBe(1);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
        .heading,
    ).toBe(first);
  });

  it("publishes a turned box even when the bounding rect is unchanged", () => {
    // Rotating a square by a quarter turn leaves its bounding box identical, so
    // the canvas would keep painting the previous angle if only rect compared.
    const square = (rotation: number): DesignRuntimeNodeDetails => ({
      ...details(),
      rect: { x: 10, y: 20, width: 80, height: 80 },
      box: {
        x: 10,
        y: 20,
        width: 80,
        height: 80,
        rotation,
        scaleX: 1,
        scaleY: 1,
        originX: 0.5,
        originY: 0.5,
      },
      styles: { left: "10px", top: "20px" },
    });
    const store = useDesignRuntimeStore.getState();
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      square(0),
      SOURCE_VERSION,
    );
    let notifications = 0;
    const unsubscribe = useDesignRuntimeStore.subscribe(() => {
      notifications += 1;
    });
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      square(90),
      SOURCE_VERSION,
    );
    expect(notifications).toBe(1);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode.heading
        ?.box?.rotation,
    ).toBe(90);
    // An identical box still reuses the retained details reference.
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      square(90),
      SOURCE_VERSION,
    );
    unsubscribe();
    expect(notifications).toBe(1);
  });

  it("promotes one mounted frame generation without discarding exact-key readback", () => {
    const store = useDesignRuntimeStore.getState();
    const currentDetails = details();
    const retainedTree = [
      {
        oid: "heading",
        tag: "h1",
        name: "Heading",
        text: "Hello",
        visible: true,
        children: [],
      },
    ];
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      {
        sourceVersion: SOURCE_VERSION,
        revision: 1,
        tree: retainedTree,
        frame: { ...currentDetails, oid: "" },
        warnings: [],
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
      },
      SOURCE_VERSION,
    );
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      currentDetails,
      SOURCE_VERSION,
    );
    const promotedDetails = {
      ...currentDetails,
      sourceVersion: NEXT_SOURCE_VERSION,
      rect: { ...currentDetails.rect, width: 240 },
      styles: { ...currentDetails.styles, width: "240px" },
    };

    const promoted = store.adoptFrameGeneration(
      "workspace-a",
      "home.html",
      SOURCE_VERSION,
      NEXT_SOURCE_VERSION,
      {
        sourceVersion: NEXT_SOURCE_VERSION,
        revision: 2,
        tree: [],
        frame: { ...promotedDetails, oid: "" },
        warnings: [],
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
      },
      [promotedDetails],
      true,
    );

    expect(promoted).toBe(true);
    expect(designRuntimeFrameState("workspace-a", "home.html")).toMatchObject({
      sourceVersion: NEXT_SOURCE_VERSION,
      snapshot: { sourceVersion: NEXT_SOURCE_VERSION, revision: 2 },
      detailsByNode: {
        heading: {
          sourceVersion: NEXT_SOURCE_VERSION,
          rect: { width: 240 },
          styles: { width: "240px" },
        },
      },
    });
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.snapshot?.tree,
    ).toBe(retainedTree);
  });
});
