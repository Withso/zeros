// Coverage for mergeWindowedTail — the merge behind the cross-device message
// reconcile (<AgentSessionsProvider>.reconcileChatMessages). The engine's
// recent-message window is authoritative; a local slot may hold MORE only
// because of a scroll-up. A remote truncate/clear shrinks the window, and the
// stale tail must be DROPPED, not overlaid back in — the "click-to-edit on
// another device leaves stale messages visible" bug this fixes.

import { describe, expect, it } from "vitest";

import { mergeWindowedTail } from "../sessions-store";
import type { AgentMessage } from "../use-agent-session";

const msg = (id: string): AgentMessage => ({
  id,
  kind: "text",
  role: "user",
  text: id,
  createdAt: 0,
});

const ids = (ms: AgentMessage[]): string[] => ms.map((m) => m.id);

describe("mergeWindowedTail", () => {
  it("replaces wholesale when the window covers the whole slot", () => {
    const cur = [msg("a"), msg("b")];
    const win = [msg("a"), msg("b"), msg("c")];
    expect(ids(mergeWindowedTail(cur, win))).toEqual(["a", "b", "c"]);
  });

  it("preserves scrolled-up history above the window", () => {
    // cur loaded older history (x,y) ABOVE the window; the window advanced to
    // a,b,c,d. Older history stays; the window owns the recent tail.
    const cur = [msg("x"), msg("y"), msg("a"), msg("b"), msg("c")];
    const win = [msg("a"), msg("b"), msg("c"), msg("d")];
    expect(ids(mergeWindowedTail(cur, win))).toEqual([
      "x",
      "y",
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("drops a remotely-truncated tail instead of overlaying it (the bug)", () => {
    // Local slot holds more than the window (e.g. >HYDRATE_WINDOW). A remote
    // click-to-edit truncated from "c", so the engine window is now [a,b]. The
    // stale c,d,e must NOT survive the merge.
    const cur = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];
    const win = [msg("a"), msg("b")];
    expect(ids(mergeWindowedTail(cur, win))).toEqual(["a", "b"]);
  });

  it("re-windows wholesale when the window head isn't loaded locally", () => {
    // No shared anchor → a full remote reset. Trust the window.
    const cur = [msg("a"), msg("b"), msg("c")];
    const win = [msg("p"), msg("q")];
    expect(ids(mergeWindowedTail(cur, win))).toEqual(["p", "q"]);
  });

  it("keeps a populated slot on an empty window (ambiguous with a bridge-null read)", () => {
    // windowMessages() returns [] both for a genuine remote clear AND when the
    // bridge is momentarily unavailable — clearing here would wipe the slot on
    // a transient. Keep current; a real clear reflects on the next re-hydrate.
    const cur = [msg("a"), msg("b")];
    expect(ids(mergeWindowedTail(cur, []))).toEqual(["a", "b"]);
  });
});
