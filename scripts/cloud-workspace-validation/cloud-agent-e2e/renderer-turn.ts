import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { CloudCommandClientRequestSchema, CloudBootCommandClientRequestSchema } from "@zeros/protocol/cloud-commands";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudEventCursorSchema } from "@zeros/protocol/cloud-events";
import type { BridgeClient } from "../lib/bridge-client";
import { createRendererDriver, type RendererBridge } from "./renderer-driver";
import { commandRequest, readCommand, collectAuthenticatedReplay } from "./driver";
import { HarnessFailure, TurnEvidence, runWithDeadline, type Provider } from "./assertions";
import { summarizeTurnTimings } from "./measurement";
import { bootMeasurementCommandRequest, sameBootMeasurementBinding } from "./boot-measurement";

type Owner = { conversationId: string; userMessageId: string; provider: Provider; model: string; prompt: string };
type Bridge = RendererBridge & Pick<BridgeClient, "request" | "engineCapabilities">;
type Scope = { organizationId: string; workspaceId: string; generation: number; engineInstanceId: string };
type Input = Owner & {
  engineWorkspaceId: string; scope: Scope; expected: "success" | "auth-failure";
  mode?: "legacy" | "boot-owner-v1"; bootBinding?: unknown;
  grant(provider: string, model: string, signal?: AbortSignal): Promise<string>;
  timeoutMs?: number; permissionMode?: string; existing?: boolean;
  onSend?(): void; onRendererSettled?(): void;
  verifyTerminal(commandId: string, entry?: ReturnType<typeof readCommand>, signal?: AbortSignal): void | Promise<void>;
  fixtureEvents?(): readonly { sequence: number; frame: Record<string, unknown> }[];
};
const scopeSchema = z.object({ organizationId: z.uuid(), workspaceId: z.uuid(), generation: z.number().int().positive(),
  engineInstanceId: z.uuid() }).strict();

/** Inspect the actual renderer envelope before forwarding it. The renderer
 * remains the only command-identity/hash producer. No prompt or grant is
 * returned or persisted by this evidence observation. */
export function captureRendererEnqueue(params: Record<string, unknown>, owner: Owner, mode: "legacy" | "boot-owner-v1" = "legacy") {
  const parsed = (mode === "boot-owner-v1" ? CloudBootCommandClientRequestSchema : CloudCommandClientRequestSchema).safeParse(params.request);
  if (!parsed.success || parsed.data.kind !== "mutate" || parsed.data.mutation.action.kind !== "enqueue")
    throw new HarnessFailure("renderer_command_invalid");
  const { mutation } = parsed.data, action = mutation.action;
  if (action.kind !== "enqueue" || mutation.conversationId !== owner.conversationId || mutation.operationId !== action.commandId ||
    action.payload.agentId !== owner.provider || action.payload.model !== owner.model ||
    action.payload.userMessageId !== owner.userMessageId || action.payload.operation ||
    JSON.stringify(action.payload.prompt) !== JSON.stringify([{ type: "text", text: owner.prompt }]))
    throw new HarnessFailure("renderer_command_invalid");
  return { commandId: action.commandId, turnId: action.payload.userMessageId };
}

/** Headless actual renderer Send with explicitly selected mode. Legacy grant
 * preparation stays measured; boot mode requires genuine negotiated metadata.
 * Raw authenticated live frames, replay and receipt are independent evidence;
 * the renderer's receipt-synthesized result never supplies missing live proof. */
export async function driveRendererTurn(bridge: Bridge, input: Input) {
  if (!bridge.engineCapabilities.includes("cloud.turnTimings.v1")) throw new HarnessFailure("timing_capability_missing");
  if (bridge.status !== "connected" || !scopeSchema.safeParse(input.scope).success ||
      !z.uuid().safeParse(input.conversationId).success || !z.uuid().safeParse(input.userMessageId).success)
    throw new HarnessFailure("renderer_command_invalid");
  const mode = input.mode ?? "legacy";
  const parsedBoot = CloudAgentBootConversationSchema.safeParse(input.bootBinding);
  const boot = mode === "boot-owner-v1" && parsedBoot.success ? parsedBoot.data : undefined;
  if (mode === "boot-owner-v1" && (!boot || !bridge.engineCapabilities.includes("cloud.localCommands.v1") ||
      ["organizationId", "workspaceId", "generation", "engineInstanceId"].some(key =>
        boot[key as keyof typeof boot] !== input.scope[key as keyof Scope])) ||
      mode === "legacy" && (input.bootBinding !== undefined || bridge.engineCapabilities.includes("cloud.localCommands.v1")))
    throw new HarnessFailure("fixture_contract_invalid");
  const commandEnvelope = (request: unknown) => boot ? bootMeasurementCommandRequest(request, boot) : commandRequest(request, 1);
  const clockId = randomUUID();
  let evidence: TurnEvidence | undefined, captured: { commandId: string; turnId: string } | undefined;
  let fingerprint: string | undefined, submitted = false, settled = false;
  let sendAtMs = 0, rendererSettledAtMs = 0;
  let floor: z.infer<typeof CloudEventCursorSchema> | undefined;
  const grantLifetime = new AbortController();
  const port: RendererBridge = {
    get status() { return bridge.status; },
    get engineCapabilities() { return bridge.engineCapabilities; },
    onMessage: listener => bridge.onMessage(listener),
    onStatusChange: listener => bridge.onStatusChange(listener),
    async requestEnvelope(op, params = {}, options) {
      if (op === "cloudCommands.request" && (params.request as { kind?: unknown } | undefined)?.kind === "mutate") {
        const parsed = (boot ? CloudBootCommandClientRequestSchema : CloudCommandClientRequestSchema).safeParse(params.request);
        if (!parsed.success || parsed.data.kind !== "mutate" || parsed.data.mutation.conversationId !== input.conversationId)
          throw new HarnessFailure("renderer_command_invalid");
        if (!floor || !sendAtMs) throw new HarnessFailure("renderer_command_invalid");
        if (parsed.data.mutation.action.kind === "resume") {
          if (submitted) throw new HarnessFailure("renderer_command_invalid");
        } else {
          const observed = captureRendererEnqueue({ request: parsed.data }, input, mode);
          if (captured && (captured.commandId !== observed.commandId || captured.turnId !== observed.turnId))
            throw new HarnessFailure("renderer_command_invalid");
          // Legitimate revision rebasing is the renderer's responsibility;
          // an attempt must retain the same command and immutable action.
          const actionDigest = createHash("sha256").update(JSON.stringify(parsed.data.mutation.action)).digest("hex");
          if (fingerprint && fingerprint !== actionDigest) throw new HarnessFailure("renderer_command_invalid");
          fingerprint = actionDigest;
          if (!captured) {
            captured = observed;
            evidence = new TurnEvidence({ provider: input.provider, conversationId: input.conversationId, commandId: observed.commandId });
            evidence.begin(floor);
          }
          // Unknown acknowledgements can still execute. Mark before the real
          // transport write so cleanup stops this exact conversation.
          submitted = true;
        }
      }
      const response = await bridge.requestEnvelope(op, params, options);
      if ((op === "cloudCommands.conversation" || op === "cloudCommands.createConversation") &&
          response.type === "WORKSPACE_RESPONSE" &&
          (response.result as { cloudTurnProtocolVersion?: unknown } | undefined)?.cloudTurnProtocolVersion !== 1)
        throw new HarnessFailure("fixture_contract_invalid");
      if (boot && (op === "cloudCommands.conversation" || op === "cloudCommands.createConversation") &&
          (response.type !== "WORKSPACE_RESPONSE" || !sameBootMeasurementBinding(
            (response.result as { cloudLocalCommands?: unknown } | undefined)?.cloudLocalCommands, boot)))
        throw new HarnessFailure("fixture_contract_invalid");
      return response;
    },
  };
  const driver = createRendererDriver(port, input.engineWorkspaceId,
    (provider, model) => input.grant(provider, model, grantLifetime.signal),
    boot ? { kind: "cloud", ...input.scope, authorityEpoch: boot.authorityEpoch, bootScope: boot } : undefined);
  const offLive = bridge.onMessage(frame => evidence?.observe(frame, "live"));
  return runWithDeadline(async signal => {
    signal.addEventListener("abort", () => grantLifetime.abort(), { once: true });
    const env = { OPENAI_MODEL: input.model, ...(input.permissionMode ? { ZEROS_PERMISSION_MODE: input.permissionMode } : {}) };
    await driver.connection.request({ type: input.existing ? "AGENT_LOAD_SESSION" : "AGENT_NEW_SESSION",
      chatId: input.conversationId, agentId: input.provider, env });
    const before = await bridge.request("cloudEvents.request", {
      request: { kind: "snapshot", conversationId: input.conversationId } }) as { cursor?: unknown };
    floor = CloudEventCursorSchema.parse(before.cursor);
    input.onSend?.(); sendAtMs = performance.now();
    await driver.connection.request({ type: "AGENT_PROMPT", sessionId: "conversation:" + input.conversationId,
      userMessageId: input.userMessageId, prompt: [{ type: "text", text: input.prompt }] }, { signal });
    rendererSettledAtMs = performance.now(); input.onRendererSettled?.();
    if (!captured || !evidence) throw new HarnessFailure("renderer_command_missing");
    let entry: ReturnType<typeof readCommand>;
    for (;;) {
      signal.throwIfAborted();
      entry = readCommand(await bridge.request("cloudCommands.request", {
        ...commandEnvelope({ kind: "read", commandId: captured.commandId }) }), { conversationId: input.conversationId, commandId: captured.commandId });
      if (["succeeded", "failed", "cancelled", "uncertain"].includes(entry.state)) break;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 25); signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
    settled = true;
    if (boot) await input.verifyTerminal(captured.commandId, entry, signal);
    else await input.verifyTerminal(captured.commandId);
    await collectAuthenticatedReplay(bridge, { conversationId: input.conversationId, floor, evidence, inspected: input.fixtureEvents });
    const result = evidence.finish(entry, input.expected);
    const beforeAtMs = performance.now();
    const inspected = await bridge.request("cloudCommands.conversation", {
      conversationId: input.conversationId, agentTurnTimingsVersion: 1 }) as { agentTurnTimings?: unknown };
    const afterAtMs = performance.now();
    const timing = summarizeTurnTimings(inspected.agentTurnTimings, { ...input.scope, conversationId: input.conversationId,
      commandId: captured.commandId, turnId: captured.turnId, executionId: entry.executionId, provider: input.provider,
      mode, bootId: boot?.bootId ?? null, writerEpoch: boot?.writerEpoch ?? null }, { clientClockId: clockId, sendAtMs, beforeAtMs, afterAtMs });
    return { commandId: captured.commandId, turnId: captured.turnId, executionId: entry.executionId, state: entry.state,
      resultCode: entry.resultCode, toolCalls: evidence.toolCalls, toolKinds: [...evidence.toolKinds], ...result, timing,
      clientTiming: { clockId, sentAtMs: sendAtMs, settledAtMs: rendererSettledAtMs },
      rendererSendToResultMs: rendererSettledAtMs - sendAtMs };
  }, async () => {
    offLive(); grantLifetime.abort(); driver.dispose(); fingerprint = undefined;
    if (submitted && !settled) await bridge.request("cloudCommands.request", {
      ...commandEnvelope({ kind: "stop", conversationId: input.conversationId, operationId: randomUUID() }) });
  }, input.timeoutMs ?? 120_000);
}
