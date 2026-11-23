import { describe, expect, it } from "vitest";
import { DesignGesturePreview } from "../state/design-gesture-preview";

describe("a gesture's live preview across document generations", () => {
  it("is offered again on a new generation once it showed on the last", () => {
    const preview = new DesignGesturePreview<{ radius: string }>();
    const drag = { radius: "14px" };
    preview.ask(drag, "a");
    expect(preview.replay("a")).toBeNull();
    preview.shown(drag, "a");
    expect(preview.replay("a")).toBeNull();
    expect(preview.replay("b")).toBe(drag);
  });

  it("keeps a preview that failed to reach the new document until it does", () => {
    const preview = new DesignGesturePreview<{ radius: string }>();
    const drag = { radius: "14px" };
    preview.ask(drag, "a");
    preview.shown(drag, "a");
    preview.ask(drag, "b");
    expect(preview.replay("b")).toBeNull();
    preview.failed(drag);
    expect(preview.replay("b")).toBe(drag);
    preview.ask(drag, "b");
    preview.shown(drag, "b");
    expect(preview.replay("b")).toBeNull();
  });

  it("holds a preview asked for while no document was current, and forgets it on commit or restore", () => {
    const preview = new DesignGesturePreview<{ radius: string }>();
    const drag = { radius: "14px" };
    preview.ask(drag, null);
    expect(preview.replay(null)).toBeNull();
    expect(preview.replay("a")).toBe(drag);
    preview.clear();
    expect(preview.replay("b")).toBeNull();
  });

  it("ignores an older request's outcome once a newer one is asked", () => {
    const preview = new DesignGesturePreview<{ radius: string }>();
    const first = { radius: "12px" };
    const second = { radius: "14px" };
    preview.ask(first, "a");
    preview.ask(second, "a");
    preview.shown(first, "a");
    preview.failed(first);
    expect(preview.replay("a")).toBeNull();
    preview.failed(second);
    expect(preview.replay("a")).toBe(second);
  });
});
