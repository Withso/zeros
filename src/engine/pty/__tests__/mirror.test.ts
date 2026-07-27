import { describe, it, expect } from "vitest";
import { TerminalMirror } from "../mirror";

// Exercises the REAL headless-xterm mirror (loads @xterm/headless +
// @xterm/addon-serialize under the runtime). The PtyService test uses a fake
// mirror; this covers the genuine serialize path the engine ships on reattach.

describe("TerminalMirror", () => {
  it("serializes the resolved screen so a reattach repaints prior output", async () => {
    const m = new TerminalMirror(80, 24);
    m.write("first line\r\n");
    m.write("second \x1b[31mred\x1b[0m line\r\n");
    const snap = await m.snapshot();
    expect(snap.bytes).toBeGreaterThan(0);
    expect(snap.truncated).toBe(false);
    // The resolved-grid blob reproduces the visible text.
    expect(snap.data).toContain("first line");
    expect(snap.data).toContain("second");
    m.dispose();
  });

  it("resize reflows the grid without throwing", async () => {
    const m = new TerminalMirror(80, 24);
    m.write("hello world\r\n");
    m.resize(120, 40);
    const snap = await m.snapshot();
    expect(snap.data).toContain("hello world");
    m.dispose();
  });

  it("snapshot stays within the byte budget (truncates scrollback if needed)", async () => {
    const m = new TerminalMirror(80, 24);
    // Write far more than the snapshot byte budget would hold at full scrollback.
    for (let i = 0; i < 5000; i++) m.write(`line ${i} ${"x".repeat(60)}\r\n`);
    const snap = await m.snapshot();
    // Walked the scrollback ladder down to fit ~256 KB; the visible screen is
    // always intact and the most recent lines survive.
    expect(snap.bytes).toBeLessThanOrEqual(256 * 1024);
    expect(snap.data).toContain("line 4999");
    m.dispose();
  });

  it("dispose is idempotent", () => {
    const m = new TerminalMirror(80, 24);
    m.dispose();
    expect(() => m.dispose()).not.toThrow();
  });
});
