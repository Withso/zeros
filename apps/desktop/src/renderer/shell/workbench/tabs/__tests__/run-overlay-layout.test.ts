// Regression: the Run sub-tab's overlay wrapper was `pointer-events-auto` while
// active. Because it is the last absolute-inset-0 child of the panel body and
// nothing in that stack sets a z-index, it hit-tested ABOVE the run terminal —
// so a run log could not be scrolled (running or finished), focused, or
// selected; only the Stop/Rerun buttons responded.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  coversPaneForPointer,
  runOverlayWrapperClass,
} from "../run-overlay-layout";

describe("run overlay hit-testing", () => {
  it("the wrapper never takes pointer events, active or not", () => {
    for (const active of [true, false]) {
      expect(coversPaneForPointer(runOverlayWrapperClass(active))).toBe(false);
    }
  });

  it("stays mounted either way — only visibility flips", () => {
    // Mounted-but-hidden is what keeps the PTY and xterm scrollback alive
    // across sub-tab switches, so the wrapper must not be conditionally
    // rendered to fix the pointer problem.
    expect(runOverlayWrapperClass(true)).toContain("visible");
    expect(runOverlayWrapperClass(false)).toContain("invisible");
    expect(runOverlayWrapperClass(true)).toContain("absolute inset-0");
  });

  it("recognises a full-cover layer that WOULD swallow the pane", () => {
    expect(coversPaneForPointer("absolute inset-0")).toBe(true);
    expect(coversPaneForPointer("pointer-events-auto absolute inset-0")).toBe(
      true,
    );
    expect(coversPaneForPointer("absolute top-0 right-0 bottom-0 left-0")).toBe(
      true,
    );
    // Content-sized boxes are fine — they only cover themselves.
    expect(coversPaneForPointer("pointer-events-auto absolute right-3 bottom-3")).toBe(
      false,
    );
    expect(coversPaneForPointer("flex items-center gap-2")).toBe(false);
  });

  it("recognises the OTHER spellings of full cover", () => {
    // A check that only knows `inset-0` passes happily while the pane is dead
    // again. Both `inset-y-0 inset-x-0` and `size-full` are already used
    // elsewhere in terminal-tab.tsx, so these are not hypothetical spellings.
    for (const cls of [
      "absolute inset-y-0 inset-x-0",
      "absolute size-full",
      "absolute h-full w-full",
      "fixed inset-0",
    ]) {
      expect(coversPaneForPointer(cls), cls).toBe(true);
      expect(coversPaneForPointer(`pointer-events-none ${cls}`), cls).toBe(false);
    }
    // One axis only cannot swallow the pane, and an unpositioned box is in flow
    // rather than a layer over anything.
    expect(coversPaneForPointer("absolute inset-y-0 right-0")).toBe(false);
    expect(coversPaneForPointer("absolute h-full")).toBe(false);
    expect(coversPaneForPointer("size-full")).toBe(false);
  });

  it("RunActionOverlay's session branch has no full-cover layer at all", () => {
    // Guards the structural half of the fix: with a terminal underneath, the
    // overlay is JUST the bottom-right cluster. A future branch that
    // reintroduces a covering rect here re-creates the bug even though the
    // wrapper is click-through, because it would nest its own.
    //
    // Anchored on structure rather than on a comment: rewording a comment used
    // to make indexOf return -1, which silently sliced an empty string and then
    // failed for the wrong reason. Note the end anchor must be `\n}\n` — a bare
    // `\n}` also matches the `}: {` and `}) {` of this component's destructured
    // signature, which truncates the body before any of the JSX.
    const src = readFileSync(
      path.join(__dirname, "..", "terminal-tab.tsx"),
      "utf8",
    );
    const start = src.indexOf("function RunActionOverlay(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    // The session branch is the final `return (…)` — everything after the
    // no-session early return's own closing `);`.
    const guard = body.indexOf("if (!session)");
    expect(guard).toBeGreaterThan(-1);
    const sessionBranch = body.slice(body.lastIndexOf("\n  return ("));
    expect(sessionBranch.length).toBeGreaterThan(50);
    expect(body.indexOf(sessionBranch)).toBeGreaterThan(guard);
    for (const cover of ["inset-0", "size-full", "inset-y-0", "h-full"]) {
      expect(sessionBranch, cover).not.toContain(cover);
    }
  });
});
