import { describe, it, expect } from "vitest";
import { TerminalMirror } from "../mirror";

// Exercise the real xterm serialization path, which the PTY service tests replace with a fake.

describe("TerminalMirror", () => {
  it("serializes the resolved screen so a reattach repaints prior output", async () => {
    const m = new TerminalMirror(80, 24);
    m.write("first line\r\n");
    m.write("second \x1b[31mred\x1b[0m line\r\n");
    const snap = await m.snapshot();
    expect(snap.bytes).toBeGreaterThan(0);
    expect(snap.truncated).toBe(false);
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
    for (let i = 0; i < 5000; i++) m.write(`line ${i} ${"x".repeat(60)}\r\n`);
    const snap = await m.snapshot();
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
