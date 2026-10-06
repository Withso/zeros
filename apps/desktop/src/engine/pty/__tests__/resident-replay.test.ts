import { expect, it, vi } from "vitest";
import { ResidentTerminalReplay } from "../resident-replay";

it("replays an exit during engine absence once per device, after its snapshot", async () => {
  const replay = new ResidentTerminalReplay<string>();
  const observed: string[] = [];
  const exit = { exitCode: 7, signal: null };
  for (const client of ["a", "b"]) {
    await replay.attach(client, "pty", () => true, async () => ({ sequence: 2, exit }),
      () => observed.push(`${client}:snapshot`), event => observed.push(`${client}:${event.kind}`), vi.fn());
  }
  replay.publish({ kind: "exit", sessionId: "pty", ...exit });
  expect(observed).toEqual(["a:snapshot", "a:exit", "b:snapshot", "b:exit"]);
});

it("deduplicates an exit received while the snapshot is pending", async () => {
  const replay = new ResidentTerminalReplay<string>();
  const exit = { exitCode: 7, signal: null }, send = vi.fn();
  let finish!: (value: { sequence: number; exit: typeof exit }) => void;
  const attaching = replay.attach("a", "pty", () => true,
    () => new Promise<{ sequence: number; exit: typeof exit }>(resolve => { finish = resolve; }), vi.fn(), send, vi.fn());
  replay.publish({ kind: "exit", sessionId: "pty", ...exit });
  finish({ sequence: 1, exit }); await attaching;
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "exit", sessionId: "pty", ...exit });
});

it("holds live output until each device has its snapshot and drops only covered sequences", async () => {
  const replay = new ResidentTerminalReplay<string>();
  let finish!: (value: { sequence: number }) => void;
  const first: string[] = [], second: string[] = [];
  const attach = replay.attach("a", "pty", () => true,
    () => new Promise<{ sequence: number }>(resolve => { finish = resolve; }),
    () => first.push("snapshot"), event => first.push(event.kind === "data" ? event.data : "exit"), vi.fn());
  await replay.attach("b", "pty", () => true, async () => ({ sequence: 1 }),
    () => second.push("snapshot"), event => second.push(event.kind === "data" ? event.data : "exit"), vi.fn());
  replay.publish({ kind: "data", sessionId: "pty", sequence: 2, data: "included" });
  replay.publish({ kind: "data", sessionId: "pty", sequence: 3, data: "after" });
  finish({ sequence: 2 }); await attach;
  expect(first).toEqual(["snapshot", "after"]);
  expect(second).toEqual(["snapshot", "included", "after"]);
  replay.release("b");
  replay.publish({ kind: "exit", sessionId: "pty", exitCode: 0, signal: null });
  expect(first.at(-1)).toBe("exit"); expect(second.at(-1)).toBe("after");
});

it("rechecks actor admission after the snapshot await and bounds pending output", async () => {
  const replay = new ResidentTerminalReplay<string>();
  let allowed = true, finish!: (value: { sequence: number }) => void;
  const snapshot = vi.fn(), live = vi.fn(), overflow = vi.fn();
  const attaching = replay.attach("a", "pty", () => allowed,
    () => new Promise<{ sequence: number }>(resolve => { finish = resolve; }), snapshot, live, overflow);
  allowed = false; finish({ sequence: 0 }); await attaching;
  expect(snapshot).not.toHaveBeenCalled(); expect(live).not.toHaveBeenCalled();
  allowed = true;
  const next = replay.attach("a", "pty", () => allowed,
    () => new Promise<{ sequence: number }>(resolve => { finish = resolve; }), snapshot, live, overflow);
  for (let sequence = 1; sequence <= 33; sequence++) replay.publish({ kind: "data", sessionId: "pty", sequence, data: "x".repeat(65536) });
  expect(overflow).toHaveBeenCalledOnce();
  finish({ sequence: 33 }); await next;
  expect(snapshot).not.toHaveBeenCalled();
});
