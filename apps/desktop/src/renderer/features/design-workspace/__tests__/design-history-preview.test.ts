import { describe, expect, it } from "vitest";
import { DesignHistoryPreview } from "../state/design-history-preview";

describe("layout history previews", () => {
  it("orders rapid undo/redo, coalesces only matching intents, and isolates workspaces", () => {
    const history = new DesignHistoryPreview();
    history.record("one", "frame", "a", "b", "state-a", "state-b");
    history.record("one", "frame", "b", "c", "state-b", "state-c");
    expect(history.take("other", "state-c", "undo")).toBeNull();
    const first = history.take("one", "state-c", "undo")!;
    const second = history.take("one", "state-c", "undo")!;
    expect([first.target, second.target]).toEqual(["b", "a"]);
    history.confirm("one", first, "state-b");
    expect(history.pendingTarget("one", "frame")).toBe("a");
    history.confirm("one", second, "state-a");
    expect(history.take("one", "state-a", "redo")?.target).toBe("b");
  });
  it("refuses predictions after an untracked or external edit", () => {
    const history = new DesignHistoryPreview();
    history.record("one", "frame", "a", "b", "state-a", "state-b");
    expect(history.take("one", "external", "undo")).toBeNull();
    expect(history.take("one", "state-b", "undo")).toBeNull();
  });
  it("bounds retained history and invalidates redo on a new edit", () => {
    const history = new DesignHistoryPreview();
    for (let i = 0; i < 100; i++)
      history.record(
        "one",
        "frame",
        String(i),
        String(i + 1),
        String(i),
        String(i + 1),
      );
    let count = 0;
    while (history.take("one", "100", "undo")) count++;
    expect(count).toBe(64);
    history.clear("one");
    expect(history.take("one", "100", "redo")).toBeNull();
  });
});
