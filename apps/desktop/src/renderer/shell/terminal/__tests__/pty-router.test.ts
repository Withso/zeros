import { describe, it, expect, vi } from "vitest";

// Regression cover for the "can't type in the 2nd-column terminal" bug.
//
// One PTY sessionId can be mounted by MORE THAN ONE TerminalSessionView at
// once: a conversation pane terminal-agent's shell is published in the engine's shared
// registry, so the workbench terminal panel (open on the same folder) mounts a
// second view for the SAME id. The PTY-data router used to keep a single
// writer per id (`Map<id, fn>`, last-bind-wins), so the live echo rendered
// into only one of the two xterms — the visible conversation pane terminal looked frozen.
// The router now fans every event out to ALL consumers bound to that id.
//
// We mock native/pty so we can capture the router's lazily-installed listener
// and drive synthetic PTY_DATA / PTY_EXIT events.

const h = vi.hoisted(() => ({
  dataHandler: null as
    | null
    | ((evt: { sessionId: string; data: string }) => void),
  exitHandler: null as
    | null
    | ((evt: {
        sessionId: string;
        exitCode: number | null;
        signal: number | null;
      }) => void),
}));

vi.mock("../../../platform/pty", () => ({
  onPtyData: (fn: (evt: { sessionId: string; data: string }) => void) => {
    h.dataHandler = fn;
    return () => {
      h.dataHandler = null;
    };
  },
  onPtyExit: (
    fn: (evt: {
      sessionId: string;
      exitCode: number | null;
      signal: number | null;
    }) => void,
  ) => {
    h.exitHandler = fn;
    return () => {
      h.exitHandler = null;
    };
  },
  ptyKill: () => {},
}));

import { bindPtyWriter, bindPtyExitHandler } from "../terminal-store";

const emitData = (sessionId: string, data: string) =>
  h.dataHandler?.({ sessionId, data });
const emitExit = (sessionId: string) =>
  h.exitHandler?.({ sessionId, exitCode: 0, signal: null });

describe("pty router fan-out", () => {
  it("delivers PTY data to EVERY view bound to the same session id", () => {
    const conversation = vi.fn();
    const workbench = vi.fn();
    const un2 = bindPtyWriter("shared", conversation);
    const un3 = bindPtyWriter("shared", workbench);

    emitData("shared", "echo");

    expect(conversation).toHaveBeenCalledWith("echo");
    expect(workbench).toHaveBeenCalledWith("echo");

    un2();
    un3();
  });

  it("keeps delivering to a co-mounted view after the other unbinds", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unA = bindPtyWriter("unbind", a);
    const unB = bindPtyWriter("unbind", b);

    unA(); // conversation pane unmounts
    emitData("unbind", "still-here");

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("still-here");

    unB();
  });

  it("routes data only to consumers of the matching session id", () => {
    const s1 = vi.fn();
    const s2 = vi.fn();
    const un1 = bindPtyWriter("id-1", s1);
    const un2 = bindPtyWriter("id-2", s2);

    emitData("id-1", "z");

    expect(s1).toHaveBeenCalledWith("z");
    expect(s2).not.toHaveBeenCalled();

    un1();
    un2();
  });

  it("fans PTY exit out to every bound exit handler", () => {
    const e1 = vi.fn();
    const e2 = vi.fn();
    const un1 = bindPtyExitHandler("exit-dup", e1);
    const un2 = bindPtyExitHandler("exit-dup", e2);

    emitExit("exit-dup");

    expect(e1).toHaveBeenCalledTimes(1);
    expect(e2).toHaveBeenCalledTimes(1);

    un1();
    un2();
  });

  it("drops the id's bucket once the last consumer unbinds (no leak)", () => {
    const fn = vi.fn();
    const un = bindPtyWriter("solo", fn);
    un();

    // No consumers left → a late event is a no-op, not a throw.
    expect(() => emitData("solo", "late")).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
