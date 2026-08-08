import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDesignLivePreview,
  designLivePreviewValue,
  publishDesignLivePreviewStyles,
  resetDesignLivePreviewForTests,
  useDesignLivePreviewStore,
} from "../state/design-live-preview";

describe("design live preview", () => {
  beforeEach(() => resetDesignLivePreviewForTests());

  it("isolates live values by workspace, frame, node, and property", () => {
    publishDesignLivePreviewStyles("workspace-a", "home.html", "heading", {
      left: "124px",
      top: "239px",
    });
    publishDesignLivePreviewStyles("workspace-b", "home.html", "heading", {
      left: "8px",
    });

    expect(
      designLivePreviewValue("workspace-a", "home.html", "heading", "left"),
    ).toBe("124px");
    expect(
      designLivePreviewValue("workspace-a", "home.html", "heading", "top"),
    ).toBe("239px");
    expect(
      designLivePreviewValue("workspace-b", "home.html", "heading", "left"),
    ).toBe("8px");

    clearDesignLivePreview("workspace-a", "home.html", "heading");
    expect(
      designLivePreviewValue("workspace-a", "home.html", "heading", "left"),
    ).toBeUndefined();
    expect(
      designLivePreviewValue("workspace-b", "home.html", "heading", "left"),
    ).toBe("8px");
  });

  it("does not notify the store for an identical live scalar snapshot", () => {
    let notifications = 0;
    const unsubscribe = useDesignLivePreviewStore.subscribe(() => {
      notifications += 1;
    });
    publishDesignLivePreviewStyles("workspace-a", "home.html", "heading", {
      left: "124px",
    });
    publishDesignLivePreviewStyles("workspace-a", "home.html", "heading", {
      left: "124px",
    });
    unsubscribe();

    expect(notifications).toBe(1);
  });
});
