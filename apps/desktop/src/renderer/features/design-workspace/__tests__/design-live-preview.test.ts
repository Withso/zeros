import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCommittedDesignLivePreviewStyles,
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

  it("rejects and settles previews per property without erasing newer input", () => {
    const firstWidth = publishDesignLivePreviewStyles(
      "workspace-a",
      "home.html",
      "heading",
      { width: "320px" },
    );
    publishDesignLivePreviewStyles("workspace-a", "home.html", "heading", {
      height: "180px",
    });
    publishDesignLivePreviewStyles("workspace-a", "home.html", "heading", {
      width: "360px",
    });

    clearDesignLivePreview("workspace-a", "home.html", "heading", firstWidth);
    clearCommittedDesignLivePreviewStyles(
      "workspace-a",
      "home.html",
      "heading",
      { width: "320px", height: "180px" },
    );

    expect(
      designLivePreviewValue("workspace-a", "home.html", "heading", "width"),
    ).toBe("360px");
    expect(
      designLivePreviewValue("workspace-a", "home.html", "heading", "height"),
    ).toBeUndefined();
  });
});
