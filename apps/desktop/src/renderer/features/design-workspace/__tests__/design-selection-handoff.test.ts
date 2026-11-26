// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESIGN_SELECTION_HANDOFF_MS,
  designHandedSelectionPresentation,
  handDesignSelectionPresentation,
  resetDesignSelectionHandoffsForTests,
  useDesignSelectionHandoff,
} from "../state/design-selection-handoff";
import {
  emphasizeDesignLayoutTools,
  useDesignLayoutToolsEmphasis,
} from "../state/design-layout-tools-live";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
function watch<T>(useValue: () => T): { current: T } {
  const seen = { current: undefined as T };
  function Probe() {
    seen.current = useValue();
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return seen;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  act(() => resetDesignSelectionHandoffsForTests());
  vi.useRealTimers();
});

const home = { frame: "home.html", nodeId: null };
const copy = { frame: "home-copy.html", nodeId: null };

describe("design selection handoff", () => {
  it("presents the subject's values only for the target it was handed to", () => {
    const shown = { ...home, details: "home values" };
    const handoff = { from: home, to: copy };
    expect(designHandedSelectionPresentation(shown, handoff, copy)).toBe(shown);
    expect(designHandedSelectionPresentation(shown, handoff, home)).toBeNull();
    expect(designHandedSelectionPresentation(shown, handoff, { ...copy, nodeId: "card" })).toBeNull();
    expect(designHandedSelectionPresentation({ ...shown, nodeId: "card" }, handoff, copy)).toBeNull();
    expect(designHandedSelectionPresentation(shown, null, copy)).toBeNull();
    expect(designHandedSelectionPresentation(null, handoff, copy)).toBeNull();
    expect(designHandedSelectionPresentation(shown, handoff, null)).toBeNull();
  });

  it("keeps one handoff per workspace until the next one or its deadline", () => {
    vi.useFakeTimers();
    const seen = watch(() => useDesignSelectionHandoff("ws"));
    const other = watch(() => useDesignSelectionHandoff("other"));
    expect(seen.current).toBeNull();
    act(() => handDesignSelectionPresentation("ws", home, copy));
    expect(seen.current).toEqual({ from: home, to: copy });
    expect(other.current).toBeNull();
    act(() => vi.advanceTimersByTime(DESIGN_SELECTION_HANDOFF_MS - 1));
    const card = { frame: "home-copy.html", nodeId: "card" };
    act(() => handDesignSelectionPresentation("ws", copy, card));
    // The replaced handoff's deadline no longer clears the new one.
    act(() => vi.advanceTimersByTime(1));
    expect(seen.current).toEqual({ from: copy, to: card });
    act(() => vi.advanceTimersByTime(DESIGN_SELECTION_HANDOFF_MS));
    expect(seen.current).toBeNull();
  });
});

describe("design layout tools emphasis", () => {
  it("shows a field's spaces while pointed at and lets only its owner clear them", () => {
    const seen = watch(() => useDesignLayoutToolsEmphasis("key"));
    const horizontal = {};
    const vertical = {};
    expect(seen.current).toBeUndefined();
    act(() => emphasizeDesignLayoutTools("key", horizontal, ["padding-left", "padding-right"]));
    expect(seen.current).toEqual(["padding-left", "padding-right"]);
    act(() => emphasizeDesignLayoutTools("key", vertical, ["padding-top", "padding-bottom"]));
    // The field the pointer left clears nothing another field now owns.
    act(() => emphasizeDesignLayoutTools("key", horizontal, null));
    expect(seen.current).toEqual(["padding-top", "padding-bottom"]);
    act(() => emphasizeDesignLayoutTools("key", vertical, []));
    expect(seen.current).toBeUndefined();
  });
});
