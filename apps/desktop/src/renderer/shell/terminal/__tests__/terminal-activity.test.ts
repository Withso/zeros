import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// createBusyTracker is the pure debounce behind useTerminalBusy — it drives the
// Conversation pane terminal-agent tab's "swap the Terminal glyph for the Z spinner while
// the agent is working" cue. We mock native/pty so importing terminal-activity
// (→ terminal-store → native/pty) doesn't pull in the real bridge transitively;
// createBusyTracker itself touches none of it.

vi.mock("../../../platform/pty", () => ({
  onPtyData: () => () => {},
  onPtyExit: () => () => {},
  ptyKill: () => {},
}));

import { createBusyTracker } from "../terminal-activity";

describe("createBusyTracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires busy=true on the first ping and busy=false once idle elapses", () => {
    const changes: boolean[] = [];
    const t = createBusyTracker((b) => changes.push(b), 600);

    t.ping();
    expect(changes).toEqual([true]);

    vi.advanceTimersByTime(599);
    expect(changes).toEqual([true]); // still inside the idle window

    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true, false]); // idle window elapsed
  });

  it("coalesces a burst — one busy=true, idle measured from the LAST ping", () => {
    const changes: boolean[] = [];
    const t = createBusyTracker((b) => changes.push(b), 600);

    t.ping();
    vi.advanceTimersByTime(300);
    t.ping(); // re-arms the idle countdown; no second busy=true
    vi.advanceTimersByTime(300);
    t.ping();
    expect(changes).toEqual([true]);

    vi.advanceTimersByTime(599);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true, false]);
  });

  it("re-arms after going idle (busy → idle → busy again)", () => {
    const changes: boolean[] = [];
    const t = createBusyTracker((b) => changes.push(b), 600);

    t.ping();
    vi.advanceTimersByTime(600);
    expect(changes).toEqual([true, false]);

    t.ping(); // a new turn starts
    expect(changes).toEqual([true, false, true]);
    vi.advanceTimersByTime(600);
    expect(changes).toEqual([true, false, true, false]);
  });

  it("dispose() cancels a pending idle transition (no late onChange)", () => {
    const changes: boolean[] = [];
    const t = createBusyTracker((b) => changes.push(b), 600);

    t.ping();
    t.dispose();
    vi.advanceTimersByTime(5000);
    expect(changes).toEqual([true]); // no trailing false from a dead consumer
  });
});
