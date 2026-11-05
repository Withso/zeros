import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionRequest, QuestionResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@zeros/protocol/agent-events";
import { CodexDriver } from "../driver";
import { ApplicationEnvironment } from "../../../credentials/application-environment";

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
  it("delivers explicit app variables and the selected proxy to the actual child", async () => {
    const { driver, events } = setup({ environment: { CLOUD_V2_WORKER_TOKEN: "synthetic-worker", ANTHROPIC_API_KEY: "synthetic-other" } });
    await driver.open({ ...openInput, application: new ApplicationEnvironment({ variables: { APP_SECRET: "synthetic-app-native" }, files: [] }) });
    await driver.prompt(content("application-environment"));
    expect(JSON.parse(prose(events))).toEqual({ application: true, selected: true, worker: false, foreignLogin: false });
  });
  it("sends active settings over native JSON-RPC and keeps them on the next turn", async () => {
    const { driver, events } = setup();
    await driver.open({ ...openInput, effort: "low" });
    const result = driver.prompt(content("settings"));
    await expect.poll(() => prose(events)).toBe("working");
    await driver.updateConfig({ effort: "high", fast: true });
    expect(prose(events)).toContain(JSON.stringify({ settings: { threadId: "native-chat", turnId: "turn-1", effort: "high", serviceTier: "fast" } }));
    await driver.interrupt(); await result;
    events.length = 0;
    await driver.prompt(content("settings-configuration"));
    expect(JSON.parse(prose(events))).toMatchObject({ effort: "high", serviceTierForTurn: "fast" });
  });

  it("keeps a lost settings reply from closing the process or failing the active turn", async () => {
    const { driver, events } = setup({ requestTimeoutMs: 1000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await driver.open({ ...openInput, effort: "low" });
      let settled = false;
      const result = driver.prompt(content("settings-no-reply")).finally(() => { settled = true; });
      void result.catch(() => {});
      await expect.poll(() => prose(events)).toBe("working");
      await expect(driver.updateConfig({ effort: "high", fast: true })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      await driver.interrupt();
      await expect(result).resolves.toMatchObject({ stopReason: "cancelled" });
      events.length = 0;
      await driver.prompt(content("settings-configuration"));
      expect(JSON.parse(prose(events))).toMatchObject({ effort: "high", serviceTierForTurn: "fast" });
    } finally { warn.mockRestore(); }
  });

  it("sends MCP through native thread configuration and redacts the capability", async () => {
    const { driver, events } = setup();
    const mcpServers = { tools: { type: "http" as const, url: "http://127.0.0.1:3222/mcp/fixture", headers: { Authorization: "Bearer fixture-mcp-secret" } } };
    await driver.open({ ...openInput, mcpServers });
    await driver.prompt(content("mcp-configuration"));
    expect(JSON.parse(prose(events))).toEqual({ config: { mcp_servers: { tools: { url: mcpServers.tools.url, http_headers: { Authorization: "[redacted]" } } } }, secretInArgs: false });
  });

  it("classifies a model refusal inside JSON-RPC data before flattening the reply", async () => {
    const { driver, events } = setup();
    await driver.open(openInput);
    const error = { message: "Request refused.", data: { code: "model_not_found", message: "Project `proj_fixture` does not have access to model `gpt-6-luna`." } };
    await expect(driver.prompt(content(`refusal:${JSON.stringify(error)}`))).rejects.toMatchObject({
      code: "model-unavailable", message: "Your OpenAI key can't use GPT-6 Luna. Pick another model.",
    });
    expect(JSON.stringify(events)).not.toContain("proj_fixture");
  });

  it.each([
    { data: { type: "modelProviderMismatch", modelProvider: "old-provider", currentModelProvider: "openai" },
      message: "This chat uses old-provider, but your current provider is openai. Switch to old-provider to continue." },
    { data: { type: "modelProviderNotConfigured", modelProvider: "unavailable" },
      message: "This chat uses model provider “unavailable”, which is no longer configured. Restore this provider’s configuration to continue." },
    { data: { type: "modelProviderPolicyConflict", modelProvider: "unavailable", requiredModelProvider: "openai" },
      message: "This chat uses model provider “unavailable”, but your organization requires “openai”. Contact your administrator or start a new chat using the required provider." },
  ])("preserves Codex provider admission errors without changing models: $data.type", async ({ data, message }) => {
    const { driver } = setup();
    await driver.open(openInput);
    const failure = await driver.prompt(content(`refusal:${JSON.stringify({ code: -32600, message, data })}`)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message });
    expect(failure).not.toHaveProperty("code", "model-unavailable");
  });

  it.each(["error", "turn/completed"])("keeps policy capacity errors distinct from overload recovery through %s", async method => {
    const { driver, events } = setup();
    await driver.open(openInput);
    const error = { message: "server overloaded", codexErrorInfo: "policyCapacityUnavailable" };
    const frames = [{ method, params: method === "error" ? { error, willRetry: false } : { turn: { status: "failed", error } } }];
    await expect(driver.prompt(content(`fixture:${JSON.stringify(frames)}`))).rejects.toThrow(error.message);
    expect(events.some(({ update }) => update.sessionUpdate === "error_notice" && update.message.includes("Retrying"))).toBe(false);
    await expect(driver.prompt(content("complete"))).resolves.toMatchObject({ stopReason: "end_turn" });
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
    expect(events.filter(event => event.update.sessionUpdate === "error_notice").map(event => event.update)).toMatchObject([
      { sessionUpdate: "error_notice", code: "cloud-question-unsupported", severity: "warning", recoverable: true,
        message: expect.stringMatching(/cloud workspaces.*Local workspace/i) },
      { sessionUpdate: "error_notice", code: "cloud-mcp-elicitation-unsupported", severity: "warning", recoverable: true,
        message: expect.stringMatching(/cloud workspaces.*Local workspace/i) },
    ]);
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


it("enables Local's native question feature only when the interaction callback is negotiated", async () => {
  for (const enabled of [false, true]) {
    const { driver, events } = setup();
    await driver.open({ ...openInput, ...(enabled ? { onQuestion: async () => ({ outcome: { outcome: "dismissed" as const } }) } : {}) });
    await driver.prompt(content("question-feature"));
    expect(JSON.parse(prose(events))).toEqual({ enabled, quiet: enabled });
  }
});

it("holds a string-id native question while streaming notifications and returns the same-turn answer", async () => {
  const { driver, events } = setup();
  let answer!: (response: QuestionResponse) => void;
  const onQuestion = vi.fn((_request: QuestionRequest) => new Promise<QuestionResponse>(resolve => { answer = resolve; }));
  await driver.open({ ...openInput, onQuestion });
  let settled = false;
  const turn = driver.prompt(content("question-roundtrip")).then(result => { settled = true; return result; });
  await expect.poll(() => prose(events)).toContain("waiting");
  expect(onQuestion).toHaveBeenCalledOnce(); expect(settled).toBe(false);
  expect(onQuestion.mock.calls[0]![0]).toMatchObject({ nativeRequestId: "native-question", blocking: true,
    questions: [{ id: "route", options: [{ id: "A", label: "A" }, { id: "B", label: "B" }] }] });
  answer({ outcome: { outcome: "answered", answers: [{ questionId: "route", selectedOptionIds: ["B"], freeText: "custom" }] } });
  await turn;
  expect(prose(events)).toBe('waiting{"answers":{"route":{"answers":["B","custom"]}}}');
});

it("uses Local's read-only native policy for a Plan thread and each turn", async () => {
  const { driver, events } = setup();
  await driver.open({ ...openInput, modeId: "read-only" });
  await driver.prompt(content("mode-configuration"));
  expect(JSON.parse(prose(events))).toEqual({ thread: { approvalPolicy: "on-request", sandbox: "read-only" },
    turn: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } });
});

it("holds native Plan approvals and accepts only the offered once-only choice", async () => {
  const { driver, events } = setup();
  let answer!: (response: RequestPermissionResponse) => void;
  const onPermission = vi.fn((_request: RequestPermissionRequest) => new Promise<RequestPermissionResponse>(resolve => { answer = resolve; }));
  await driver.open({ ...openInput, modeId: "read-only", onPermission });
  const turn = driver.prompt(content("approval-roundtrip"));
  await expect.poll(() => prose(events)).toContain("waiting");
  expect(onPermission).toHaveBeenCalledOnce();
  expect(onPermission.mock.calls[0]![0].options).toContainEqual(expect.objectContaining({ optionId: "accept", kind: "allow_once" }));
  answer({ outcome: { outcome: "selected", optionId: "accept" } });
  await turn;
  expect(prose(events)).toBe('waiting{"decision":"accept"}');
});

it.each([
  { policy: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } }, id: "acceptWithExecpolicyAmendment:1", kind: "allow_always" },
  { policy: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.test", action: "deny" } } }, id: "applyNetworkPolicyAmendment:1", kind: "reject_always" },
])("preserves native command decision order and original policy objects: $id", async ({ policy, id, kind }) => {
  const { driver, events } = setup();
  const onPermission = vi.fn(async (_request: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "selected", optionId: id } }));
  await driver.open({ ...openInput, modeId: "read-only", onPermission });
  await driver.prompt(content(`approval-fixture:${JSON.stringify({ method: "item/commandExecution/requestApproval", params: {
    itemId: "command", command: ["git", "status"], availableDecisions: ["decline", policy, "accept"],
  } })}`));
  expect(onPermission.mock.calls[0]![0]).toMatchObject({ useOptionNames: true, allowLocalPolicies: false,
    options: [{ optionId: "decline" }, { optionId: id, kind }, { optionId: "accept" }], toolCall: { title: "Run: git status", kind: "execute" } });
  expect(JSON.parse(prose(events))).toEqual({ decision: policy });
});

it.each(["execCommandApproval", "applyPatchApproval"])("uses the provider's structured v1 decline shape for %s", async method => {
  const { driver, events } = setup();
  await driver.open({ ...openInput, modeId: "read-only", onPermission: async () => ({ outcome: { outcome: "selected", optionId: "decline" } }) });
  await driver.prompt(content(`approval-fixture:${JSON.stringify({ method, params: { callId: "legacy", command: "git status" } })}`));
  expect(JSON.parse(prose(events))).toEqual({ decision: { denied: { rejection: "User declined this action." } } });
});

it("mirrors only the native requested permission profile and selected session scope", async () => {
  const { driver, events } = setup();
  const permissions = { network: { enabled: false }, fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/tmp/requested" } }] } };
  const onPermission = vi.fn(async (_request: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "selected", optionId: "acceptForSession" } }));
  await driver.open({ ...openInput, modeId: "read-only", onPermission });
  await driver.prompt(content(`approval-fixture:${JSON.stringify({ method: "item/permissions/requestApproval", params: { itemId: "permissions", permissions, reason: "Write the selected file" } })}`));
  expect(onPermission.mock.calls[0]![0]).toMatchObject({ toolCall: { kind: "switch_mode", rawInput: { permissions } } });
  expect(JSON.parse(prose(events))).toEqual({ permissions, scope: "session" });
});

it("correlates a native file approval with its streamed file paths", async () => {
  const { driver, events } = setup();
  const onPermission = vi.fn(async (_request: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "cancelled" } }));
  await driver.open({ ...openInput, modeId: "read-only", onPermission });
  await driver.prompt(content(`approval-fixture:${JSON.stringify({ method: "item/fileChange/requestApproval", params: { itemId: "patch" }, events: [
    { method: "item/started", params: { item: { type: "fileChange", id: "patch", status: "inProgress", changes: [{ path: "/workspace/a.txt", kind: { type: "update" }, diff: "" }] } } },
  ] })}`));
  expect(onPermission.mock.calls[0]![0]).toMatchObject({ toolCall: { kind: "edit", nativeToolCallId: "patch", rawInput: { filePaths: ["/workspace/a.txt"] } } });
  expect(JSON.parse(prose(events))).toEqual({ decision: "cancel" });
});

it("does not turn an unoffered renderer choice into a native command grant", async () => {
  const { driver, events } = setup();
  await driver.open({ ...openInput, modeId: "read-only", onPermission: async () => ({ outcome: { outcome: "selected", optionId: "accept" } }) });
  await driver.prompt(content(`approval-fixture:${JSON.stringify({ method: "item/commandExecution/requestApproval", params: { itemId: "unsupported", availableDecisions: ["future-grant"] } })}`));
  expect(JSON.parse(prose(events))).toEqual({ decision: "cancel" });
});

it("shows the same concrete outside-workspace write scope as Local", async () => {
  const { driver } = setup();
  const onPermission = vi.fn(async (_request: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "cancelled" } }));
  await driver.open({ ...openInput, modeId: "read-only", onPermission });
  await driver.prompt(content(`approval-fixture:${JSON.stringify({ method: "item/commandExecution/requestApproval", params: {
    itemId: "outside-write", cwd: "/workspace/repo", command: "write fixture", additionalPermissions: { fileSystem: { write: ["../one.txt"] } },
  } })}`));
  expect(onPermission.mock.calls[0]![0]).toMatchObject({ title: "Do you want to allow write access outside the workspace?",
    contextItems: ["Write · ../one.txt"], toolCall: { rawInput: { codexWriteAccessPath: "../one.txt" } } });
});
