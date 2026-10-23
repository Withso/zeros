import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { CodexDriver } from "../driver";

const drivers: CodexDriver[] = [];
afterEach(async () => { await Promise.all(drivers.splice(0).map((driver) => driver.dispose())); });
const content = (text: string) => [{ type: "text" as const, text }];
const openInput = {
  sessionId: "execution-1", cwd: process.cwd(), model: "fixture-model",
  proxy: { baseUrl: "http://127.0.0.1:1/v1", token: "offline-placeholder" },
};
function setup(options: { requestTimeoutMs?: number; interruptTimeoutMs?: number; environment?: NodeJS.ProcessEnv } = {}) {
  const driver = new CodexDriver({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))],
    environment: {},
    ...options,
  });
  drivers.push(driver);
  const events: SessionNotification[] = [];
  driver.onEvent((event) => events.push(event));
  return { driver, events };
}
const prose = (events: SessionNotification[]) => events.flatMap(({ update }) =>
  update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("");

describe("Codex driver with an offline app-server process", () => {
  it("classifies a model refusal inside JSON-RPC data before flattening the reply", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    const error = { message: "Request refused.", data: { code: "model_not_found", message: "Project `proj_fixture` does not have access to model `gpt-6-luna`." } };
    await expect(driver.prompt(content(`refusal:${JSON.stringify(error)}`))).rejects.toMatchObject({
      code: "model-unavailable", message: "Your OpenAI key can't use GPT-6 Luna. Pick another model.",
    });
    expect(JSON.stringify(events)).not.toContain("proj_fixture");
  });

  it.each(["error", "turn/completed", "rpc"])("keeps model refusal diagnostics out of %s replies and transcript rows", async method => {
    const { driver, events } = setup();
    const message = "unexpected status 403 Forbidden: Project `proj_fixture` does not have access to model `gpt-6.1-sol`, url: https://proxy.example.test/v2/cloud/proxy/openai/responses, cf-ray: fixture-ray, request id: fixture-request";
    const error = { message, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } };
    await driver.open({ ...openInput, model: "gpt-6.1-sol" });
    const frames = [{ method, params: method === "error" ? { error, willRetry: false } : { turn: { status: "failed", error } } }];
    const prompt = method === "rpc" ? `refusal:${JSON.stringify(error)}` : `fixture:${JSON.stringify(frames)}`;
    const failure = await driver.prompt(content(prompt)).catch((value: unknown) => value);
    expect(failure).toMatchObject({ code: "model-unavailable", message: "Your OpenAI key can't use GPT-6.1 Sol. Pick another model." });
    expect(JSON.stringify(events)).not.toMatch(/proj_fixture|https:|fixture-ray|fixture-request/);
    if (method === "error") expect(events.find(event => event.update.sessionUpdate === "error_notice")?.update)
      .toMatchObject({ message: "Your OpenAI key can't use GPT-6.1 Sol. Pick another model." });
  });

  it("reports native process and turn timing boundaries for cold and reused sends", async () => {
    const { driver } = setup(), stages: string[] = [];
    await driver.open({ ...openInput, onTiming: stage => { stages.push(stage); } });
    expect(stages).toEqual(["process_ready"]);
    for (const mode of ["complete", "before-ack"]) {
      stages.length = 0; await driver.prompt(content(mode));
      expect(stages).toEqual(["turn_sent", "first_provider_event"]);
    }
  });

  it("pins the Luna model and low effort on the native turn request", async () => {
    const { driver, events } = setup();
    await driver.open({ ...openInput, model: "gpt-6-luna", effort: "low" });
    await driver.prompt(content("cost-configuration"));
    expect(JSON.parse(prose(events))).toEqual({ model: "gpt-6-luna", effort: "low", reasoningEffort: "low", effectiveEffort: "low" });
  });

  it.each([
    ["minimal", "minimal"], ["medium", "medium"], ["HIGH", "high"], [" xhigh ", "xhigh"],
    ["max", "max"], ["ultracode", "ultra"], ["ultra", "ultra"],
    [undefined, undefined], ["", undefined], ["unknown", undefined],
  ])("maps Codex effort %s exactly as Local does", async (effort, expected) => {
    const { driver, events } = setup();
    await driver.open({ ...openInput, effort });
    await driver.prompt(content("cost-configuration"));
    expect(JSON.parse(prose(events))).toEqual({ model: openInput.model, reasoningEffort: expected ?? null,
      ...(expected ? { effort: expected, effectiveEffort: expected } : {}) });
  });

  it("preserves effort for the same model and clears it for a different model", async () => {
    const { driver, events } = setup();
    await driver.open({ ...openInput, model: "gpt-6-luna", effort: "low" });
    await driver.setModel("gpt-6-luna");
    await driver.prompt(content("cost-configuration"));
    expect(JSON.parse(prose(events))).toEqual({ model: "gpt-6-luna", effort: "low", reasoningEffort: "low", effectiveEffort: "low" });
    events.length = 0;
    await driver.setModel("fixture-next-model");
    await driver.prompt(content("cost-configuration"));
    expect(JSON.parse(prose(events))).toEqual({ model: "fixture-next-model", reasoningEffort: null });
  });

  it("keeps worker and other-agent credentials out of the native process", async () => {
    const { driver, events } = setup({ environment: {
      ZEROS_WORKER_TOKEN: "fixture-worker", CURSOR_API_KEY: "fixture-cursor", ANTHROPIC_AUTH_TOKEN: "fixture-claude",
    } });
    await driver.open(openInput);
    await driver.prompt(content("configuration"));
    expect(JSON.parse(prose(events))).toEqual({ worker: false, cursor: false, claude: false, own: true, tokenInArgs: false });
  });

  it("opens, streams a turn and resumes the same native chat in a new process", async () => {
    const first = setup();
    const opened = await first.driver.open(openInput);
    expect(opened.nativeSessionId).toBe("native-chat");
    expect(await first.driver.prompt(content("complete"))).toMatchObject({ stopReason: "end_turn" });
    expect(prose(first.events)).toBe("hello");
    expect(first.events.every((event) => event.sessionId === "execution-1")).toBe(true);
    await first.driver.dispose();
    const second = setup();
    expect(await second.driver.open({ ...openInput, sessionId: "execution-2", nativeSessionId: opened.nativeSessionId })).toEqual(opened);
    await second.driver.prompt(content("complete"));
    expect(second.events.every((event) => event.sessionId === "execution-2")).toBe(true);
  });

  it("waits past the turn acknowledgement and interrupts the exact native turn", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    let settled = false;
    const result = driver.prompt(content("wait")).then((value) => { settled = true; return value; });
    await expect.poll(() => prose(events)).toBe("working");
    expect(settled).toBe(false);
    await driver.interrupt();
    expect(await result).toMatchObject({ stopReason: "cancelled" });
    expect(await driver.prompt(content("complete"))).toMatchObject({ stopReason: "end_turn" });
  });

  it("preserves terminal events that arrive before the turn acknowledgement", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    expect(await driver.prompt(content("before-ack"))).toMatchObject({ stopReason: "end_turn" });
    expect(prose(events)).toBe("early");
  });

  it("keeps Stop intent until a delayed turn acknowledgement supplies its identity", async () => {
    const { driver } = setup();
    await driver.open(openInput);
    const pending = driver.prompt(content("slow-ack"));
    await driver.interrupt();
    expect(await pending).toMatchObject({ stopReason: "cancelled" });
  });

  it("steers an active turn and does not claim delivery when idle or stopping", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    expect(await driver.steer(content("idle"))).toBe("queued");
    const pending = driver.prompt(content("wait"));
    await expect.poll(() => prose(events)).toBe("working");
    expect(await driver.steer(content(" direction"))).toBe("delivered");
    await expect.poll(() => prose(events)).toBe("working direction");
    const stopped = driver.interrupt();
    expect(await driver.steer(content("too late"))).toBe("queued");
    await stopped;
    await pending;
  });

  it("applies a model change to the next turn", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    await driver.setModel("next-model");
    const result = await driver.prompt(content("model"));
    expect(prose(events)).toBe("next-model");
    expect(result.effectiveModel).toBe("next-model");
  });

  it("isolates other native threads and retired turns", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    await driver.prompt(content("foreign"));
    expect(prose(events)).toBe("hello");
  });

  it("answers unsupported native requests without hanging the turn", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    await driver.prompt(content("requests"));
    const responses = JSON.parse(prose(events));
    expect(responses[0]).toEqual({ decision: "decline" });
    expect(responses[1]).toEqual({ decision: "decline" });
    expect(responses[2]).toEqual({ answers: {} });
    expect(responses[3]).toMatchObject({ action: "cancel" });
    expect(responses[4]).toMatchObject({ code: -32601 });
  });

  it.each(["crash", "malformed", "no-ack"])("settles a prompt on %s without leaking process output", async (mode) => {
    const { driver } = setup({ requestTimeoutMs: 500 });
    await driver.open(openInput);
    await expect(driver.prompt(content(mode))).rejects.toThrow();
  });

  it("kills an unresponsive native turn after the interrupt deadline", async () => {
    const { driver, events } = setup({ interruptTimeoutMs: 150 });
    await driver.open(openInput);
    const pending = driver.prompt(content("ignore-interrupt")).catch((error: unknown) => error);
    await expect.poll(() => prose(events)).toBe("working");
    await expect(driver.interrupt()).rejects.toThrow(/interrupt/i);
    expect(await pending).toBeInstanceOf(Error);
  });

  it("rejects overlapping prompts and settles active work on disposal", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    const pending = driver.prompt(content("wait")).catch((error: unknown) => error);
    await expect.poll(() => prose(events)).toBe("working");
    await expect(driver.prompt(content("overlap"))).rejects.toThrow(/active/i);
    await driver.dispose();
    expect(await pending).toBeInstanceOf(Error);
    await expect(driver.prompt(content("after disposal"))).rejects.toThrow();
  });
});
