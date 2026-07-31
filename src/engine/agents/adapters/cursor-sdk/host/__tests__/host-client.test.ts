// Tests for the bun-side Cursor host client: the proxy that drives the Node
// @cursor/sdk subprocess (cursor-host.cjs) over stdio NDJSON. We exercise the
// request/response correlation, run-stream event marshaling, error
// reconstruction across the process boundary, and host-death handling with an
// in-memory fake transport (no real subprocess). The real subprocess + network
// path is covered by an out-of-band E2E (host → @cursor/sdk → Cursor 401).

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  AsyncMsgQueue,
  CursorHostClient,
  toHostError,
  type HostTransport,
} from "../host-client";
import { classifyCursorSdkError } from "../../adapter";

/** In-memory transport that records the engine→host lines and lets the test
 *  push host→engine lines back. Mirrors one cursor-host.cjs over a pipe. */
class FakeTransport implements HostTransport {
  sent: Array<Record<string, unknown>> = [];
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: (() => void) | null = null;
  disposed = false;

  send(line: string): void {
    this.sent.push(JSON.parse(line));
  }
  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: () => void): void {
    this.exitCb = cb;
  }
  dispose(): void {
    this.disposed = true;
  }

  /** Push one host→engine protocol object. */
  emit(obj: Record<string, unknown>): void {
    this.lineCb?.(JSON.stringify(obj) + "\n");
  }
  /** Push a raw stdout slice verbatim (no added newline) — to simulate a single
   *  protocol line split across `data`-event chunk boundaries. */
  feedRaw(s: string): void {
    this.lineCb?.(s);
  }
  /** Simulate the host process dying. */
  die(): void {
    this.exitCb?.();
  }
  lastReq(): Record<string, unknown> {
    return this.sent[this.sent.length - 1];
  }
  reqOf(op: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.op === op);
  }
}

function makeClient(): { client: CursorHostClient; fake: FakeTransport } {
  const fake = new FakeTransport();
  const client = new CursorHostClient(() => fake);
  return { client, fake };
}

describe("AsyncMsgQueue", () => {
  it("yields buffered items pushed before iteration starts, then ends", async () => {
    const q = new AsyncMsgQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  it("delivers items pushed while a consumer is awaiting", async () => {
    const q = new AsyncMsgQueue<string>();
    const out: string[] = [];
    const done = (async () => {
      for await (const v of q) out.push(v);
    })();
    q.push("a");
    q.push("b");
    q.end();
    await done;
    expect(out).toEqual(["a", "b"]);
  });

  it("throws the failure after draining buffered items", async () => {
    const q = new AsyncMsgQueue<number>();
    q.push(7);
    q.fail(new Error("boom"));
    const out: number[] = [];
    await expect(
      (async () => {
        for await (const v of q) out.push(v);
      })(),
    ).rejects.toThrow("boom");
    expect(out).toEqual([7]);
  });
});

describe("toHostError", () => {
  it("rebuilds an error carrying name/status/code for the classifier", () => {
    const err = toHostError({
      message: "Invalid User API Key",
      name: "AuthenticationError",
      status: 401,
      code: "auth",
    }) as Error & { status?: number; code?: string };
    expect(err.message).toBe("Invalid User API Key");
    expect(err.name).toBe("AuthenticationError");
    expect(err.status).toBe(401);
    expect(err.code).toBe("auth");
    // And the adapter's classifier turns that into the Sign-in chip.
    expect(classifyCursorSdkError(err, "prompt").failure.kind).toBe(
      "auth-required",
    );
  });
});

describe("CursorHostClient proxy", () => {
  it("create → send → stream → wait round-trips over the protocol", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();

    const pAgent = mod.Agent.create({ apiKey: "k", model: { id: "composer-2" } });
    const createReq = fake.reqOf("agent.create")!;
    expect(createReq.args).toMatchObject({ apiKey: "k" });
    fake.emit({ k: "res", id: createReq.id, ok: true, result: { agentId: "a1" } });
    const agent = await pAgent;
    expect(agent.agentId).toBe("a1");

    const pSend = agent.send({ text: "hi" }, { mode: "agent" });
    const sendReq = fake.reqOf("agent.send")!;
    const runId = (sendReq.args as { runId: string }).runId;
    expect((sendReq.args as { agentId: string }).agentId).toBe("a1");
    fake.emit({ k: "res", id: sendReq.id, ok: true, result: { sdkRunId: "sdk-99" } });
    const run = await pSend;
    expect(run.id).toBe("sdk-99");

    // Drain the stream while the host pushes items + an end marker.
    const collected: unknown[] = [];
    const streamDone = (async () => {
      for await (const m of run.stream()) collected.push(m);
    })();
    fake.emit({ k: "ev", ev: "run.msg", runId, msg: { type: "text", text: "a" } });
    fake.emit({ k: "ev", ev: "run.msg", runId, msg: { type: "result", status: "completed" } });
    fake.emit({ k: "ev", ev: "run.streamEnd", runId });
    await streamDone;
    expect(collected).toEqual([
      { type: "text", text: "a" },
      { type: "result", status: "completed" },
    ]);

    const pWait = run.wait();
    const waitReq = fake.reqOf("run.wait")!;
    expect((waitReq.args as { runId: string }).runId).toBe(runId);
    fake.emit({ k: "res", id: waitReq.id, ok: true, result: { status: "completed" } });
    expect(await pWait).toEqual({ status: "completed" });
  });

  it("reassembles a host line split across stdout chunks (no drop)", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();
    const p = mod.Agent.create({ apiKey: "k" });
    const req = fake.reqOf("agent.create")!;
    // The host's response arrives in two raw stdout chunks split mid-line — the
    // first chunk has NO trailing newline. Appending "\n" per chunk would
    // force-terminate the partial line and drop the whole message; the client
    // must buffer the partial until the real newline arrives.
    const line = JSON.stringify({
      k: "res",
      id: req.id,
      ok: true,
      result: { agentId: "split-1" },
    });
    const mid = Math.floor(line.length / 2);
    fake.feedRaw(line.slice(0, mid)); // partial, no newline
    fake.feedRaw(line.slice(mid) + "\n"); // remainder + terminator
    expect((await p).agentId).toBe("split-1");
  });

  it("propagates a run.streamError as a throw from the stream iterator", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();
    const pAgent = mod.Agent.create({});
    fake.emit({ k: "res", id: fake.reqOf("agent.create")!.id, ok: true, result: { agentId: "a1" } });
    const agent = await pAgent;

    const pSend = agent.send({ text: "x" }, {});
    const sendReq = fake.reqOf("agent.send")!;
    const runId = (sendReq.args as { runId: string }).runId;
    fake.emit({ k: "res", id: sendReq.id, ok: true, result: { sdkRunId: "s1" } });
    const run = await pSend;

    const iterate = (async () => {
      for await (const _m of run.stream()) {
        /* drain */
      }
    })();
    fake.emit({
      k: "ev",
      ev: "run.streamError",
      runId,
      error: { message: "max mode not supported", name: "ConfigurationError", status: 400 },
    });
    await expect(iterate).rejects.toThrow("max mode not supported");
  });

  it("rejects a request when the host returns ok:false, preserving status", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();
    const p = mod.Agent.create({ apiKey: "bad" });
    const req = fake.reqOf("agent.create")!;
    fake.emit({
      k: "res",
      id: req.id,
      ok: false,
      error: { message: "Invalid User API Key", name: "AuthenticationError", status: 401 },
    });
    await expect(p).rejects.toMatchObject({ status: 401, name: "AuthenticationError" });
  });

  it("rejects in-flight requests and fails live streams when the host dies", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();

    // Bring an agent + run up first.
    const pAgent = mod.Agent.create({});
    fake.emit({ k: "res", id: fake.reqOf("agent.create")!.id, ok: true, result: { agentId: "a1" } });
    const agent = await pAgent;
    const pSend = agent.send({ text: "x" }, {});
    fake.emit({ k: "res", id: fake.reqOf("agent.send")!.id, ok: true, result: { sdkRunId: "s1" } });
    const run = await pSend;

    // A live stream + a pending wait, then the host vanishes.
    const streamFailed = (async () => {
      for await (const _m of run.stream()) {
        /* drain */
      }
    })();
    const pWait = run.wait();
    fake.die();

    await expect(pWait).rejects.toThrow(/cursor host/i);
    await expect(streamFailed).rejects.toThrow(/cursor host/i);
  });

  it("tags an UNEXPECTED host death so it classifies transport-closed (recoverable)", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();
    const pAgent = mod.Agent.create({});
    fake.die();

    let caught: unknown;
    try {
      await pAgent;
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("CURSOR_HOST_EXITED");
    // End-to-end: the classifier must route the tagged death RECOVERABLE —
    // the next call respawns the host, so no hard error toast.
    const failure = classifyCursorSdkError(caught, "prompt");
    expect(failure.failure.kind).toBe("transport-closed");
  });

  it("a fatal-preceded death stays UNTAGGED (terminal) — a respawn would fail identically", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();
    const pAgent = mod.Agent.create({});
    fake.emit({ k: "fatal", message: "@cursor/sdk could not be loaded: MODULE_NOT_FOUND" });
    fake.die();

    let caught: unknown;
    try {
      await pAgent;
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBeUndefined();
    expect(String((caught as Error).message)).toMatch(/could not be loaded/);
    const failure = classifyCursorSdkError(caught, "prompt");
    expect(failure.failure.kind).toBe("protocol-error");
  });

  it("registers the run queue before sending, so an early run.msg is not lost", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();
    const pAgent = mod.Agent.create({});
    fake.emit({ k: "res", id: fake.reqOf("agent.create")!.id, ok: true, result: { agentId: "a1" } });
    const agent = await pAgent;

    const pSend = agent.send({ text: "x" }, {});
    const sendReq = fake.reqOf("agent.send")!;
    const runId = (sendReq.args as { runId: string }).runId;
    // Host emits a stream item IMMEDIATELY after (but before we read the stream)
    // — the queue already exists because send() registered it pre-request.
    fake.emit({ k: "res", id: sendReq.id, ok: true, result: { sdkRunId: "s1" } });
    fake.emit({ k: "ev", ev: "run.msg", runId, msg: { type: "text", text: "early" } });
    fake.emit({ k: "ev", ev: "run.streamEnd", runId });
    const run = await pSend;

    const collected: unknown[] = [];
    for await (const m of run.stream()) collected.push(m);
    expect(collected).toEqual([{ type: "text", text: "early" }]);
  });

  it("routes agent.list / models.list / store ops through the proxy", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();

    const pList = mod.Agent.list({ runtime: "local", cwd: "/w" });
    fake.emit({ k: "res", id: fake.reqOf("agent.list")!.id, ok: true, result: { items: [{ agentId: "x" }] } });
    expect(await pList).toEqual({ items: [{ agentId: "x" }] });

    const pModels = mod.Cursor!.models.list({ apiKey: "k" });
    fake.emit({ k: "res", id: fake.reqOf("models.list")!.id, ok: true, result: [{ id: "composer-2" }] });
    expect(await pModels).toEqual([{ id: "composer-2" }]);

    const pStore = mod.LocalAgentStore!.open({ workspaceRef: "/w" });
    fake.emit({ k: "res", id: fake.reqOf("store.open")!.id, ok: true, result: { storeId: "st1" } });
    const store = await pStore;
    const pGet = store.runs.get({ agentId: "a1", runId: "r1" });
    const getReq = fake.reqOf("store.runGet")!;
    expect(getReq.args).toMatchObject({ storeId: "st1", agentId: "a1", runId: "r1" });
    fake.emit({ k: "res", id: getReq.id, ok: true, result: { status: "error", error: "boom" } });
    expect(await pGet).toEqual({ status: "error", error: "boom" });
  });

  it("returns null from a store opened with no backing (storeId null)", async () => {
    const { client, fake } = makeClient();
    const mod = client.module();
    const pStore = mod.LocalAgentStore!.open({ workspaceRef: "/w" });
    fake.emit({ k: "res", id: fake.reqOf("store.open")!.id, ok: true, result: { storeId: null } });
    const store = await pStore;
    expect(await store.runs.get({ agentId: "a", runId: "r" })).toBeNull();
    // No request is sent for a null store.
    expect(fake.reqOf("store.runGet")).toBeUndefined();
  });
});

// ── Crash-loop guard: bounded respawn + backoff + ready-line gate ──────────
//
// A host that keeps dying at boot (before `ready` / within 5s of spawn) must
// not be respawned on every message: from the 2nd consecutive early death a
// hold-off blocks respawn (1s, 2s, … capped), and from the 3rd the rejection
// turns TERMINAL (CURSOR_HOST_CRASH_LOOP tag → protocol-error + user-facing
// failure.advice) so the renderer stops silently retrying. A healthy run
// (ready + ≥5s uptime) resets the counter — a long-lived host crashing once
// stays a recoverable blip. Fatal-preceded deaths stay terminal at EVERY
// count, including during the hold-off.
describe("CursorHostClient crash-loop guard", () => {
  function makeRespawningClient() {
    const transports: FakeTransport[] = [];
    const client = new CursorHostClient(() => {
      const t = new FakeTransport();
      transports.push(t);
      return t;
    });
    return {
      client,
      spawns: () => transports.length,
      latest: () => transports[transports.length - 1],
    };
  }
  const rejectionOf = async (p: Promise<unknown>) => {
    try {
      await p;
      throw new Error("expected rejection");
    } catch (err) {
      return err as Error & { code?: string };
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds off respawn after the 2nd consecutive early death (no spawn, fast fail)", async () => {
    const { client, spawns, latest } = makeRespawningClient();
    const mod = client.module();

    // 1st early death: recoverable, NO hold-off — a one-off blip heals on retry.
    const p1 = mod.Agent.create({});
    latest().die();
    const e1 = await rejectionOf(p1);
    expect(e1.code).toBe("CURSOR_HOST_EXITED");

    // 2nd early death: still recoverable, but a hold-off starts.
    const p2 = mod.Agent.create({});
    expect(spawns()).toBe(2);
    latest().die();
    const e2 = await rejectionOf(p2);
    expect(e2.code).toBe("CURSOR_HOST_EXITED");

    // Immediate 3rd call: rejected FAST without spawning a 3rd process.
    const e3 = await rejectionOf(mod.Agent.create({}));
    expect(spawns()).toBe(2);
    expect(e3.message).toMatch(/holding off respawn/i);
    expect(e3.code).toBe("CURSOR_HOST_EXITED"); // below threshold → recoverable

    // After the hold-off elapses, the next call respawns (half-open).
    vi.advanceTimersByTime(1_100);
    void mod.Agent.create({}).catch(() => {});
    expect(spawns()).toBe(3);
  });

  it("turns TERMINAL with an actionable message at the 3rd consecutive early death", async () => {
    const { client, latest } = makeRespawningClient();
    const mod = client.module();

    for (let i = 1; i <= 2; i++) {
      const p = mod.Agent.create({});
      latest().die();
      await rejectionOf(p);
      vi.advanceTimersByTime(60_000); // clear the hold-off between attempts
    }
    const p3 = mod.Agent.create({});
    latest().die();
    const e3 = await rejectionOf(p3);
    // Terminal — no silent retry — but distinctly tagged so the classifier
    // can attach the user-facing advice (the toast layer drops technical
    // message detail; failure.advice is what still reaches the user).
    expect(e3.code).toBe("CURSOR_HOST_CRASH_LOOP");
    expect(e3.message).toMatch(/crashed 3 times in a row/i);
    expect(e3.message).toMatch(/ZEROS_PTY_HOST_RUNTIME/);
    const classified = classifyCursorSdkError(e3, "prompt");
    expect(classified.failure.kind).toBe("protocol-error");
    expect(classified.failure.advice).toMatch(/ZEROS_PTY_HOST_RUNTIME/);

    // Requests during the terminal hold-off fail fast AND terminal.
    const e4 = await rejectionOf(mod.Agent.create({}));
    expect(e4.code).toBe("CURSOR_HOST_CRASH_LOOP");
    expect(e4.message).toMatch(/holding off respawn/i);
    expect(classifyCursorSdkError(e4, "prompt").failure.kind).toBe(
      "protocol-error",
    );
  });

  it("fatal-preceded deaths stay TERMINAL during the hold-off (no recoverable tag)", async () => {
    const { client, latest } = makeRespawningClient();
    const mod = client.module();

    // Two consecutive fatal-preceded boot deaths (broken install — a respawn
    // fails identically). Each rejection is terminal.
    for (let i = 1; i <= 2; i++) {
      const p = mod.Agent.create({});
      latest().emit({
        k: "fatal",
        message: "@cursor/sdk could not be loaded: MODULE_NOT_FOUND",
      });
      latest().die();
      const e = await rejectionOf(p);
      expect(e.code).toBeUndefined();
    }

    // A request inside the hold-off window must NOT flip recoverable — the
    // guard knows the host is terminally broken — and must keep naming the
    // fatal reason instead of a bare "the Cursor SDK host crashed".
    const e3 = await rejectionOf(mod.Agent.create({}));
    expect(e3.message).toMatch(/holding off respawn/i);
    expect(e3.message).toMatch(/could not be loaded/);
    expect(e3.code).toBeUndefined();
    expect(classifyCursorSdkError(e3, "prompt").failure.kind).toBe(
      "protocol-error",
    );
  });

  it("a healthy run (ready + uptime) resets the loop counter", async () => {
    const { client, latest } = makeRespawningClient();
    const mod = client.module();

    // Two early deaths bring the counter to 2…
    for (let i = 1; i <= 2; i++) {
      const p = mod.Agent.create({});
      latest().die();
      await rejectionOf(p);
      vi.advanceTimersByTime(60_000);
    }
    // …then a HEALTHY run: ready line, 6s of uptime, then a crash.
    const p3 = mod.Agent.create({});
    latest().emit({ k: "ready" });
    vi.advanceTimersByTime(6_000);
    latest().die();
    const e3 = await rejectionOf(p3);
    // Healthy death: counter reset — still recoverable, not the loop message.
    expect(e3.code).toBe("CURSOR_HOST_EXITED");
    expect(e3.message).not.toMatch(/crashed .* times/i);

    // And the NEXT early death counts as 1 again (recoverable, no terminal).
    const p4 = mod.Agent.create({});
    latest().die();
    const e4 = await rejectionOf(p4);
    expect(e4.code).toBe("CURSOR_HOST_EXITED");
  });
});
