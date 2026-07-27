import { describe, expect, it } from "vitest";

import {
  reconcileObservedIframeHistory,
  snapshotIframeHistory,
} from "../../zeros/browser/iframe-history";

const A = "https://example.com/a";
const B = "https://example.com/b";
const C = "https://example.com/c";

describe("iframe browser history reconciliation", () => {
  it("moves backward and forward when an in-page traversal reaches an adjacent entry", () => {
    const back = reconcileObservedIframeHistory([A, B], 1, A, null, true);
    expect(back).toEqual({ entries: [A, B], index: 0 });

    const forward = reconcileObservedIframeHistory(
      back.entries,
      back.index,
      B,
      null,
      true,
    );
    expect(forward).toEqual({ entries: [A, B], index: 1 });
  });

  it("truncates the forward arm for a genuinely new internal navigation", () => {
    expect(
      reconcileObservedIframeHistory([A, B, C], 1, `${B}/new`, null, true),
    ).toEqual({
      entries: [A, B, `${B}/new`],
      index: 2,
    });
  });

  it("appends a full navigation even when its URL matches the previous entry", () => {
    expect(reconcileObservedIframeHistory([A, B], 1, A, null, false)).toEqual({
      entries: [A, B, A],
      index: 2,
    });
  });

  it("replaces an explicitly requested entry with its redirect destination", () => {
    expect(reconcileObservedIframeHistory([A, B], 1, C, B)).toEqual({
      entries: [A, C],
      index: 1,
    });
  });

  it("snapshots entries by value so a cancelled load can restore them", () => {
    const entries = [A, B];
    const snapshot = snapshotIframeHistory(entries, 1);
    entries.push(C);
    expect(snapshot).toEqual({ entries: [A, B], index: 1 });
  });
});
