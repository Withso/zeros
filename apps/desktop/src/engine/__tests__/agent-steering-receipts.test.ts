import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../index";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";

interface Internals {
  agents: { steer: (...args: unknown[]) => Promise<string> };
  sessionAgent: Map<string, string>;
  activeTurnSnapshots: Map<string, { turnId: string }>;
  cancelRequested: Set<string>;
  clearAgentExecutionRoute: (executionId: string) => void;
  assertAgentSessionProcessStartAllowed: (...args: unknown[]) => void;
  persistSteeredUserPrompt: (...args: unknown[]) => void;
  handleMessage: (
    message: EngineMessage,
    client: TransportClient,
  ) => Promise<void>;
}
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-steering-"));
  roots.push(root);
  const state = new ZerosEngine({ root, port: 0 }) as unknown as Internals;
  vi.spyOn(state, "assertAgentSessionProcessStartAllowed").mockImplementation(
    () => {},
  );
  const persist = vi
    .spyOn(state, "persistSteeredUserPrompt")
    .mockImplementation(() => {});
  const native = vi.spyOn(state.agents, "steer");
  state.sessionAgent.set("execution", "cursor");
  state.activeTurnSnapshots.set("execution", { turnId: "A" });
  const responses: EngineMessage[] = [];
  const client: TransportClient = {
    id: "renderer",
    kind: "local",
    send: (m) => responses.push(m),
    close: vi.fn(),
  };
  const send = (id: string, attemptId: string | undefined = "attempt") =>
    state.handleMessage(
      {
        type: "AGENT_STEER",
        id,
        source: "browser",
        timestamp: 1,
        agentId: "cursor",
        sessionId: "execution",
        userMessageId: "C",
        attemptId,
        prompt: [{ type: "text", text: "C" }],
      },
      client,
    );
  return { state, native, persist, responses, send };
}
describe("engine steering receipts", () => {
  it("never makes a lost delivery resendable after execution retirement", async () => {
    const h = setup();
    h.native.mockResolvedValue("delivered");
    await h.send("first");
    h.state.activeTurnSnapshots.delete("execution");
    h.state.clearAgentExecutionRoute("execution");
    await h.send("retry");
    expect(h.responses[1]).toMatchObject({
      type: "AGENT_STEERED",
      outcome: "interrupted",
    });
    expect(h.native).toHaveBeenCalledOnce();
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it("cannot redispatch after retirement while the old prompt is still settling", async () => {
    const h = setup();
    h.native.mockResolvedValue("delivered");
    const receipt = h.send("first");
    h.state.clearAgentExecutionRoute("execution");
    await receipt;
    expect(h.responses[0]).toMatchObject({
      type: "AGENT_STEERED",
      outcome: "interrupted",
    });
    expect(h.native).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("treats an unknown execution after engine restart as uncertain", async () => {
    const h = setup();
    h.state.sessionAgent.clear();
    h.state.activeTurnSnapshots.clear();
    await h.send("retry");
    expect(h.responses[0]).toMatchObject({
      type: "AGENT_STEERED",
      outcome: "interrupted",
    });
    expect(h.native).not.toHaveBeenCalled();
  });

  it("replays a confirmed receipt even if new provider work is no longer admitted", async () => {
    const h = setup();
    h.native.mockResolvedValue("delivered");
    await h.send("first");
    vi.mocked(h.state.assertAgentSessionProcessStartAllowed).mockImplementation(
      () => { throw new Error("workspace no longer admits provider work"); },
    );
    await h.send("retry");
    expect(h.responses[1]).toMatchObject({
      type: "AGENT_STEERED",
      outcome: "delivered",
      turnId: "A",
    });
    expect(h.native).toHaveBeenCalledOnce();
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it("can queue new input for a known execution whose turn already finished", async () => {
    const h = setup();
    h.state.activeTurnSnapshots.clear();
    await h.send("first");
    expect(h.responses[0]).toMatchObject({
      type: "AGENT_STEERED",
      outcome: "queued",
    });
    expect(h.native).not.toHaveBeenCalled();
  });

  it("can retry an attempt that was rejected before delivery admission", async () => {
    const h = setup();
    h.native.mockResolvedValue("delivered");
    vi.mocked(h.state.assertAgentSessionProcessStartAllowed).mockImplementationOnce(
      () => { throw new Error("workspace transition in progress"); },
    );
    await h.send("first");
    expect(h.responses[0]).toMatchObject({ type: "AGENT_ERROR" });
    expect(h.native).not.toHaveBeenCalled();
    // The rejection reply could also be lost. Its original attempt must be
    // usable once admission reopens because no delivery was ever dispatched.
    await h.send("retry");
    expect(h.responses[1]).toMatchObject({
      type: "AGENT_STEERED",
      outcome: "delivered",
      turnId: "A",
    });
    expect(h.native).toHaveBeenCalledOnce();
  });

  it("shares retries and persists confirmed delivery against the original turn", async () => {
    const h = setup();
    let acknowledge!: (outcome: string) => void;
    h.native.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const first = h.send("first");
    const retry = h.send("retry");
    await vi.waitFor(() => expect(h.native).toHaveBeenCalledOnce());
    h.state.activeTurnSnapshots.set("execution", { turnId: "D" });
    acknowledge("delivered");
    await Promise.all([first, retry]);
    await h.send("late");
    expect(h.native).toHaveBeenCalledOnce();
    expect(h.persist).toHaveBeenCalledOnce();
    expect(h.persist.mock.calls[0]?.at(-1)).toBe("A");
    expect(h.responses).toHaveLength(3);
    for (const response of h.responses)
      expect(response).toMatchObject({
        type: "AGENT_STEERED",
        outcome: "delivered",
        turnId: "A",
      });
  });

  it("cannot steer a replacement turn born between receipt creation and dispatch", async () => {
    const h = setup();
    h.native.mockResolvedValue("delivered");
    const receipt = h.send("first");
    h.state.activeTurnSnapshots.set("execution", { turnId: "D" });
    await receipt;
    expect(h.native).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.responses[0]).toMatchObject({
      type: "AGENT_STEERED",
      outcome: "queued",
    });
  });

  it("does not tell legacy clients that an unconsumed follow-up was delivered", async () => {
    const h = setup();
    h.native.mockResolvedValue("queued");
    await h.send("legacy", "");
    expect(h.responses[0]).toMatchObject({
      type: "AGENT_ERROR",
      code: "STEER_NOT_DELIVERED",
    });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("keeps a Stop-rejected message queued without persisting a false delivery", async () => {
    const h = setup();
    h.state.cancelRequested.add("execution");
    await h.send("first");
    expect(h.native).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.responses[0]).toMatchObject({
      type: "AGENT_STEERED",
      outcome: "queued",
    });
  });
});
