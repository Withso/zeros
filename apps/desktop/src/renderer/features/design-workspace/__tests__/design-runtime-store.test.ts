import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { beforeEach, describe, expect, it } from "vitest";

import {
  designRuntimeFrameState,
  resetDesignRuntimeStoreForTests,
  useDesignRuntimeStore,
} from "../state/design-runtime-store";

const SOURCE_VERSION = "1".repeat(24);

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
});
