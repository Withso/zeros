import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SimulatorInput, SimulatorTouch } from "@zeros/protocol/simulators";

import { TouchStream } from "../devices/touch-stream";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const at = (x: number, y: number) => ({ x, y });
const down = (x: number, y: number): SimulatorTouch => ({ phase: "down", at: at(x, y) });
const move = (x: number, y: number): SimulatorTouch => ({ phase: "move", at: at(x, y) });
const up = (x: number, y: number): SimulatorTouch => ({ phase: "up", at: at(x, y) });

describe("live touches", () => {
  let now: number;
  let sent: SimulatorTouch[];
  let performed: SimulatorInput[];
  let gates: Array<ReturnType<typeof deferred<boolean>>> | null;
  let live: boolean;
  let logs: string[];
  let stream: TouchStream;

  beforeEach(() => {
    now = 1_000;
    sent = [];
    performed = [];
    gates = null;
    live = true;
    logs = [];
    stream = new TouchStream({
      send: (touch) => {
        sent.push(touch);
        if (!gates) return Promise.resolve(live);
        const gate = deferred<boolean>();
        gates.push(gate);
        return gate.promise;
      },
      perform: async (gesture) => {
        performed.push(gesture);
      },
      now: () => now,
      log: (line) => logs.push(line),
    });
  });

  it("sends each step as it happens, and says what the press did once it ends", async () => {
    await expect(stream.push("view-1", down(100, 100))).resolves.toBeNull();
    expect(stream.pressed).toBe(true);
    await stream.push("view-1", move(100, 150));
    now += 240;
    await expect(stream.push("view-1", up(100, 300))).resolves.toEqual({
      kind: "drag",
      from: at(100, 100),
      to: at(100, 300),
      durationMs: 240,
    });
    expect(sent).toEqual([down(100, 100), move(100, 150), up(100, 300)]);
    expect(stream.pressed).toBe(false);
    expect(performed).toEqual([]);
  });

  it("keeps one step in flight, folding moves behind a slow device into the newest", async () => {
    gates = [];
    const first = stream.push("view-1", down(10, 10));
    const moves = [move(10, 20), move(10, 30), move(10, 40)].map((step) =>
      stream.push("view-1", step),
    );
    const lift = stream.push("view-1", up(10, 50));
    await flush();
    expect(sent).toEqual([down(10, 10)]);
    gates[0]!.resolve(true);
    await expect(first).resolves.toBeNull();
    await flush();
    expect(sent).toEqual([down(10, 10), move(10, 40)]);
    gates[1]!.resolve(true);
    await expect(Promise.all(moves)).resolves.toEqual([null, null, null]);
    await flush();
    expect(sent.at(-1)).toEqual(up(10, 50));
    gates[2]!.resolve(true);
    await expect(lift).resolves.toMatchObject({ kind: "drag" });
  });

  it("says what a two-finger press did once it ends", async () => {
    const pinch = (phase: SimulatorTouch["phase"], reach: number): SimulatorTouch => ({
      phase,
      at: at(201 - reach, 437),
      second: at(201 + reach, 437),
    });
    void stream.push("view-1", pinch("down", 25));
    void stream.push("view-1", pinch("move", 40));
    await expect(stream.push("view-1", pinch("up", 50))).resolves.toEqual({
      kind: "pinch",
      scale: 2,
    });
    expect(sent.map((step) => [step.phase, step.second?.x])).toEqual([
      ["down", 226],
      ["move", 241],
      ["up", 251],
    ]);
  });

  it("doesn't count a cancelled press, though it lifts the finger", async () => {
    void stream.push("view-1", down(5, 5));
    await expect(stream.push("view-1", { phase: "cancel", at: at(5, 9) })).resolves.toBeNull();
    expect(sent.map((step) => step.phase)).toEqual(["down", "cancel"]);
  });

  it("sends a press it can't send live whole, once it ends", async () => {
    live = false;
    await stream.push("view-1", down(100, 100));
    await stream.push("view-1", move(100, 200));
    now += 300;
    await expect(stream.push("view-1", up(100, 300))).resolves.toEqual({
      kind: "drag",
      from: at(100, 100),
      to: at(100, 300),
      durationMs: 300,
    });
    expect(sent).toEqual([down(100, 100)]);
    expect(performed).toEqual([
      { kind: "drag", from: at(100, 100), to: at(100, 300), durationMs: 300 },
    ]);

    await stream.push("view-1", down(1, 1));
    await stream.push("view-1", { phase: "cancel", at: at(1, 1) });
    expect(performed).toHaveLength(1);
  });

  it("after a step fails, drops the rest of the press but still lifts the finger", async () => {
    gates = [];
    void stream.push("view-1", down(1, 1));
    const failed = stream.push("view-1", move(1, 20));
    gates[0]!.resolve(true);
    await flush();
    gates[1]!.reject(new Error("That didn't reach iPhone 17."));
    await expect(failed).rejects.toThrow("That didn't reach iPhone 17.");
    await expect(stream.push("view-1", move(1, 30))).resolves.toBeNull();
    const lift = stream.push("view-1", up(1, 40));
    await flush();
    expect(sent).toEqual([down(1, 1), move(1, 20), up(1, 40)]);
    gates[2]!.reject(new Error("again"));
    await expect(lift).resolves.toBeNull();

    gates = null;
    await stream.push("view-1", down(2, 2));
    await expect(stream.push("view-1", up(2, 2))).resolves.toEqual({ kind: "tap", at: at(2, 2) });
  });

  it("doesn't count a live press that lost its way, nor send what's left of it", async () => {
    await stream.push("view-1", down(1, 1));
    live = false;
    await stream.push("view-1", move(1, 50));
    await expect(stream.push("view-1", up(1, 90))).resolves.toBeNull();
    expect(sent).toEqual([down(1, 1), move(1, 50)]);
    expect(performed).toEqual([]);
    expect(logs).toEqual(["a live touch stopped partway; the rest of the press was dropped"]);
  });

  it("lifts a finger left down before a new press, or when its view lets go", async () => {
    await stream.push("view-1", down(10, 10));
    await stream.push("view-1", move(10, 20));
    await stream.push("view-1", down(50, 50));
    expect(sent.slice(2)).toEqual([{ phase: "cancel", at: at(10, 20) }, down(50, 50)]);

    await expect(stream.push("view-2", up(50, 60))).resolves.toBeNull();
    await stream.release("view-2");
    expect(stream.pressed).toBe(true);
    await stream.release("view-1");
    expect(stream.pressed).toBe(false);
    expect(sent.at(-1)).toEqual({ phase: "cancel", at: at(50, 50) });
    expect(sent).toHaveLength(5);

    await stream.push("view-2", down(1, 1));
    await stream.release();
    expect(sent.at(-1)).toEqual({ phase: "cancel", at: at(1, 1) });
  });

  it("ignores steps outside a press, and a press that changes its fingers", async () => {
    await expect(stream.push("view-1", move(1, 1))).resolves.toBeNull();
    await expect(stream.push("view-1", up(1, 1))).resolves.toBeNull();
    await stream.push("view-1", { phase: "down", at: at(1, 1), second: at(9, 9) });
    await stream.push("view-1", move(2, 2));
    expect(sent).toEqual([{ phase: "down", at: at(1, 1), second: at(9, 9) }]);
  });

  it("forgets the press without sending once the device is gone", async () => {
    gates = [];
    const first = stream.push("view-1", down(1, 1));
    const rest = stream.push("view-1", move(1, 9));
    stream.drop();
    await expect(rest).resolves.toBeNull();
    gates[0]!.resolve(true);
    await expect(first).resolves.toBeNull();
    await flush();
    expect(sent).toEqual([down(1, 1)]);
    expect(stream.pressed).toBe(false);
    await stream.release();
    expect(sent).toHaveLength(1);
  });

  it("starts the next press only once a whole press went out", async () => {
    live = false;
    const performGate = deferred<void>();
    stream = new TouchStream({
      send: (touch) => {
        sent.push(touch);
        return Promise.resolve(live);
      },
      perform: vi.fn(async (gesture: SimulatorInput) => {
        performed.push(gesture);
        await performGate.promise;
      }),
      now: () => now,
    });
    await stream.push("view-1", down(1, 1));
    const lifted = stream.push("view-1", up(1, 1));
    const next = stream.push("view-1", down(5, 5));
    await flush();
    expect(sent).toEqual([down(1, 1)]);
    performGate.resolve();
    await expect(lifted).resolves.toEqual({ kind: "tap", at: at(1, 1) });
    await next;
    expect(sent).toEqual([down(1, 1), down(5, 5)]);
  });
});
