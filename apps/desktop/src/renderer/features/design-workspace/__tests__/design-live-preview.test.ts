import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCommittedDesignLivePreviewStyles,
  clearDesignLivePreview,
  designLivePreviewValue,
  publishDesignLivePreviewStyles,
  publishDesignGestureLivePreview,
  resetDesignLivePreviewForTests,
  useDesignLivePreviewStore,
} from "../state/design-live-preview";
import {
  clearDesignHistoryPresentation,
  presentDesignHistory,
  presentDesignHistoryRuntime,
  setDesignHistoryPresentationOwnerReader,
} from "../state/design-history-presentation";
import { resetDesignWorkspaceUiForTests } from "../state/design-workspace-ui";

function presentInverse(workspace: string, sequence: number, token = {}) {
  presentDesignHistory(workspace, token, {});
  const detail = { sourceVersion: "before", oid: "hero", tag: "div", name: "Hero", text: null,
    selector: "div", breadcrumb: [], visible: true, styles: { "border-radius": "0px" },
    rect: { x: 0, y: 0, width: 100, height: 100 } };
  presentDesignHistoryRuntime(workspace, token, "home.html", {
    sourceVersion: "before", snapshot: { frame: { ...detail, oid: "body" } }, details: [detail],
  }, sequence);
  return token;
}

describe("design live preview", () => {
  beforeEach(() => {
    resetDesignLivePreviewForTests();
    resetDesignWorkspaceUiForTests();
    clearDesignHistoryPresentation();
    setDesignHistoryPresentationOwnerReader(() => "owner-a");
  });
  afterEach(() => {
    resetDesignLivePreviewForTests();
    clearDesignHistoryPresentation();
    setDesignHistoryPresentationOwnerReader(() => "");
    vi.useRealTimers();
  });

  it("publishes the latest paused gesture without exceeding the refresh rate", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let notifications = 0;
    const unsubscribe = useDesignLivePreviewStore.subscribe(
      () => notifications++,
    );
    const publish = (left: string) =>
      publishDesignGestureLivePreview("workspace-a", "home.html", "heading", {
        left,
      });
    publish("0px");
    vi.advanceTimersByTime(20);
    publish("105px");
    vi.advanceTimersByTime(50);
    publish("117px");
    expect(notifications).toBe(1);
    vi.advanceTimersByTime(30);
    unsubscribe();
    expect(
      designLivePreviewValue("workspace-a", "home.html", "heading", "left"),
    ).toBe("117px");
    expect(notifications).toBe(2);
  });

  it("does not resurrect cancelled or settled values from a pending gesture", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    for (const node of ["cancelled", "settled"]) {
      publishDesignGestureLivePreview("workspace-a", "home.html", node, {
        left: "0px",
      });
      publishDesignGestureLivePreview("workspace-a", "home.html", node, {
        left: "20px",
      });
    }
    clearDesignLivePreview("workspace-a", "home.html", "cancelled");
    publishDesignGestureLivePreview(
      "workspace-a",
      "home.html",
      "settled",
      { left: "30px" },
      { settle: true },
    );
    vi.advanceTimersByTime(200);
    expect(
      designLivePreviewValue("workspace-a", "home.html", "cancelled", "left"),
    ).toBeUndefined();
    expect(
      designLivePreviewValue("workspace-a", "home.html", "settled", "left"),
    ).toBe("30px");
  });

  it("retains pending properties without overwriting newer inspector input", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    publishDesignGestureLivePreview("workspace-a", "home.html", "heading", {
      left: "0px",
    });
    publishDesignGestureLivePreview("workspace-a", "home.html", "heading", {
      left: "20px",
      height: "180px",
    });
    publishDesignLivePreviewStyles("workspace-a", "home.html", "heading", {
      left: "40px",
    });
    vi.advanceTimersByTime(100);
    expect(
      designLivePreviewValue("workspace-a", "home.html", "heading", "left"),
    ).toBe("40px");
    expect(
      designLivePreviewValue("workspace-a", "home.html", "heading", "height"),
    ).toBe("180px");
  });

  it("bounds pending publications without dropping a group's last values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    for (let index = 0; index < 65; index++) {
      const node = `node-${index}`;
      publishDesignGestureLivePreview("workspace-a", "home.html", node, {
        left: "0px",
      });
      publishDesignGestureLivePreview("workspace-a", "home.html", node, {
        left: "20px",
      });
    }
    expect(vi.getTimerCount()).toBeLessThanOrEqual(32);
    vi.advanceTimersByTime(100);
    expect(vi.getTimerCount()).toBe(0);
    for (let index = 0; index < 65; index++) {
      expect(
        designLivePreviewValue(
          "workspace-a",
          "home.html",
          `node-${index}`,
          "left",
        ),
      ).toBe("20px");
    }
  });

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

  it("suppresses older scalars only where an exact inverse has details and restores them if it is cleared", () => {
    const publication = publishDesignLivePreviewStyles("workspace-a", "home.html", "hero", {
      "border-radius": "24px", padding: "8px",
    });
    for (const [workspace, frame, node] of [
      ["workspace-b", "home.html", "hero"],
      ["workspace-a", "other.html", "hero"],
      ["workspace-a", "home.html", "other"],
    ]) publishDesignLivePreviewStyles(workspace!, frame!, node!, { "border-radius": "12px" });
    const token = presentInverse("workspace-a", Math.max(...Object.values(publication)));
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "border-radius")).toBeUndefined();
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "padding")).toBeUndefined();
    expect(designLivePreviewValue("workspace-b", "home.html", "hero", "border-radius")).toBe("12px");
    expect(designLivePreviewValue("workspace-a", "other.html", "hero", "border-radius")).toBe("12px");
    expect(designLivePreviewValue("workspace-a", "home.html", "other", "border-radius")).toBe("12px");
    publishDesignLivePreviewStyles("workspace-a", "home.html", "hero", { "border-radius": "32px" });
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "border-radius")).toBe("32px");
    clearDesignHistoryPresentation("workspace-a", token);
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "padding")).toBe("8px");
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "border-radius")).toBe("32px");
  });

  it("notifies when identical new input supersedes an inverse, then keeps identical snapshots stable", () => {
    const publication = publishDesignLivePreviewStyles("workspace-a", "home.html", "hero", { "border-radius": "24px" });
    presentInverse("workspace-a", publication["border-radius"]!);
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "border-radius")).toBeUndefined();
    let notifications = 0;
    const unsubscribe = useDesignLivePreviewStore.subscribe(() => { notifications++; });
    publishDesignLivePreviewStyles("workspace-a", "home.html", "hero", { "border-radius": "24px" });
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "border-radius")).toBe("24px");
    expect(notifications).toBe(1);
    publishDesignLivePreviewStyles("workspace-a", "home.html", "hero", { "border-radius": "24px" });
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("does not apply a replaced owner's inverse to its live values", () => {
    const publication = publishDesignLivePreviewStyles("workspace-a", "home.html", "hero", { "border-radius": "24px" });
    presentInverse("workspace-a", publication["border-radius"]!);
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "border-radius")).toBeUndefined();
    setDesignHistoryPresentationOwnerReader(() => "owner-b");
    expect(designLivePreviewValue("workspace-a", "home.html", "hero", "border-radius")).toBe("24px");
  });
});
