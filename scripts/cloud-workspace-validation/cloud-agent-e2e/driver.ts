import { randomUUID } from "node:crypto";
import { CloudCommandClientRequestSchema, CloudCommandEntrySchema, CloudCommandSnapshotSchema } from "@zeros/protocol/cloud-commands";
import { CloudEventCursorSchema, CloudEventReplayResultSchema } from "@zeros/protocol/cloud-events";
import type { BridgeClient, BridgeMessage } from "../lib/bridge-client";
import { HarnessFailure, TurnEvidence, runWithDeadline, type Provider } from "./assertions";

type Client = Pick<BridgeClient, "onMessage" | "request" | "close"> & { connect(): Promise<unknown> };
export function commandRequest(request: unknown, cloudTurnProtocolVersion?: 1) {
  return { nativeCommandsVersion: 1, ...(cloudTurnProtocolVersion === 1 ? { cloudTurnProtocolVersion: 1 } : {}),
    request: CloudCommandClientRequestSchema.parse(request) };
}
/** Match the renderer heartbeat; actor admission expires without activity. */
export function keepActorAlive(client: Pick<BridgeClient, "sendMessage">): () => void {
  const timer = setInterval(() => {
    try { client.sendMessage({ type: "HEARTBEAT" }); }
    catch { clearInterval(timer); }
  }, 5000);
  timer.unref?.();
  return () => clearInterval(timer);
}
/** CloudAgentConnection sends the engine identity selected by workspace.list;
 * its outer cloud key/CP UUID is translated at the renderer wire boundary. */
export function selectEngineWorkspace(value: unknown, authority: { workspaceId: string; organizationId: string }): string {
  const rows = (value as { workspaces?: unknown })?.workspaces;
  if (!Array.isArray(rows)) throw new HarnessFailure("fixture_contract_invalid");
  const matches = rows.filter(row => row && typeof row === "object" && row.canonicalId === authority.workspaceId &&
    row.organizationId === authority.organizationId && row.placement === "cloud" && row.path === "/srv/zeros/workspace" && row.id === "local-main");
  if (matches.length !== 1) throw new HarnessFailure("fixture_contract_invalid");
  return matches[0].id;
}
const ReadCommandSchema = CloudCommandEntrySchema.extend({ conversationId: CloudCommandSnapshotSchema.shape.conversationId }).strict();
export function readCommand(value: unknown, owner: { conversationId: string; commandId: string }) {
  const entry = ReadCommandSchema.parse(value);
  if (entry.conversationId !== owner.conversationId || entry.commandId !== owner.commandId) throw new HarnessFailure("receipt_mismatch");
  return entry;
}
export async function cancelAfterToolStart(probe: () => Promise<boolean>, stop: () => Promise<unknown>, timeoutMs = 10_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) { await stop(); return; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new HarnessFailure("stop_evidence_missing");
}
export async function authenticateEngine(client: Client, listener: (frame: BridgeMessage) => void): Promise<() => void> {
  const unsubscribe = client.onMessage(listener);
  try { await client.connect(); await client.request("workspace.list"); return unsubscribe; }
  catch { unsubscribe(); client.close(); throw new HarnessFailure("engine_authentication_failed"); }
}
export type Enqueue = { conversationId: string; commandId: string; provider: Provider; model: string; grantId: string;
  revision: number; modeRevision: number; permissionMode: string; prompt: string; cloudTurnProtocolVersion?: 1 };
export function enqueueRequest(input: Enqueue) {
  const request = CloudCommandClientRequestSchema.parse({ kind: "mutate", mutation: { conversationId: input.conversationId,
    operationId: input.commandId, expectedRevision: input.revision, action: { kind: "enqueue", commandId: input.commandId,
      payload: { agentId: input.provider, userMessageId: input.commandId, prompt: [{ type: "text", text: input.prompt }],
        modeRevision: input.modeRevision, permissionMode: input.permissionMode, agentCredentialGrantId: input.grantId, model: input.model } } } });
  return commandRequest(request, input.cloudTurnProtocolVersion);
}
export async function driveTurn(client: Client, input: Omit<Enqueue, "revision" | "modeRevision"> & {
  workspaceId: string; existing?: boolean; expected: "success" | "auth-failure" | "admission-failure" | "cancelled";
  timeoutMs?: number; replayEvents?: () => readonly { sequence: number; frame: Record<string, unknown> }[];
  onTool?: () => void; stopMidTool?: boolean; toolStarted?: () => Promise<boolean>; requireCloudTurnProtocol?: boolean;
}) {
  const evidence = new TurnEvidence({ provider: input.provider, conversationId: input.conversationId, commandId: input.commandId });
  let submitted = false, settled = false, stopping: Promise<unknown> | undefined;
  let collecting = false;
  let cloudTurnProtocolVersion: 1 | undefined;
  const unsubscribe = client.onMessage(frame => {
    if (!collecting) return;
    evidence.observe(frame, "live");
    if (evidence.toolCalls) {
      input.onTool?.();
      if (input.stopMidTool && !stopping) {
        stopping = cancelAfterToolStart(input.toolStarted ?? (async () => false), () => client.request("cloudCommands.request",
          commandRequest({ kind: "stop", conversationId: input.conversationId, operationId: randomUUID() }, cloudTurnProtocolVersion)));
        // Observe promptly; the receipt path below still awaits and propagates
        // failure. A diagnostic callback cannot cause an unhandled rejection.
        void stopping.catch(() => {});
      }
    }
  });
  return runWithDeadline(async signal => {
    if (!input.existing) await client.request("cloudCommands.createConversation", { conversationId: input.conversationId,
      workspaceId: input.workspaceId, agentId: input.provider, model: input.model });
    const conversation = await client.request("cloudCommands.conversation", { conversationId: input.conversationId }) as {
      modeRevision: number; cloudTurnProtocolVersion?: unknown };
    if (conversation.cloudTurnProtocolVersion !== undefined && conversation.cloudTurnProtocolVersion !== 1 ||
      input.requireCloudTurnProtocol && conversation.cloudTurnProtocolVersion !== 1) throw new HarnessFailure("fixture_contract_invalid");
    cloudTurnProtocolVersion = conversation.cloudTurnProtocolVersion === 1 ? 1 : undefined;
    const snapshot = CloudCommandSnapshotSchema.parse(await client.request("cloudCommands.request",
      commandRequest({ kind: "snapshot", conversationId: input.conversationId }, cloudTurnProtocolVersion)));
    if (snapshot.paused) throw new HarnessFailure("fixture_contract_invalid");
    const before = await client.request("cloudEvents.request", { request: { kind: "snapshot", conversationId: input.conversationId } }) as { cursor: unknown };
    const floor = CloudEventCursorSchema.parse(before.cursor);
    evidence.begin(floor); collecting = true;
    // The command may execute even if its acknowledgement is lost. Mark the
    // uncertainty before sending so cleanup cancels it without re-enqueueing.
    submitted = true;
    await client.request("cloudCommands.request", enqueueRequest({ ...input, cloudTurnProtocolVersion,
      revision: snapshot.revision, modeRevision: conversation.modeRevision }));
    while (!signal.aborted) {
      const entry = readCommand(await client.request("cloudCommands.request",
        commandRequest({ kind: "read", commandId: input.commandId }, cloudTurnProtocolVersion)), input);
      if (["succeeded", "failed", "cancelled", "uncertain"].includes(entry.state)) {
        settled = true;
        await stopping;
        // Exercise the same authenticated replay operation as CloudEventReader.
        const state = await client.request("cloudEvents.request", { request: { kind: "snapshot", conversationId: input.conversationId } }) as { cursor: unknown };
        const head = CloudEventCursorSchema.parse(state.cursor);
        if (head.streamId !== floor.streamId || head.sequence < floor.sequence) throw new HarnessFailure("replay_content_mismatch");
        let sequence = floor.sequence, pages = 0;
        const inspected = input.replayEvents?.();
        for (;;) {
          const replay = CloudEventReplayResultSchema.parse(await client.request("cloudEvents.request", {
            request: { kind: "replay", cursor: { streamId: floor.streamId, sequence } },
          }));
          if (replay.streamId !== floor.streamId || replay.cursor > replay.head || replay.head < sequence ||
            replay.events.some((event, index) => event.sequence !== sequence + index + 1) ||
            replay.cursor !== (replay.events.at(-1)?.sequence ?? sequence) || ++pages > 100)
            throw new HarnessFailure("missing_replay");
          if (replay.head > sequence && !replay.events.length) throw new HarnessFailure("missing_replay");
          for (const event of replay.events) {
            const stream = event.frame.cloudStream as { streamId?: unknown; sequence?: unknown; requiresSnapshot?: unknown } | undefined;
            if (stream?.streamId !== replay.streamId || stream.sequence !== event.sequence || stream.requiresSnapshot === true)
              throw new HarnessFailure("replay_content_mismatch");
            // Fixture inspection is only a consistency cross-check. It can
            // never replace an event absent from authenticated bridge replay.
            if (inspected && !inspected.some(item => item.sequence === event.sequence && JSON.stringify(item.frame) === JSON.stringify(event.frame)))
              throw new HarnessFailure("receipt_mismatch");
            evidence.observe(event.frame, "replay");
          }
          sequence = replay.cursor;
          if (sequence === replay.head) break;
        }
        return { commandId: input.commandId, state: entry.state, resultCode: entry.resultCode, toolCalls: evidence.toolCalls,
          toolKinds: [...evidence.toolKinds],
          ...evidence.finish(entry, input.expected) };
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 100); signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
    throw new HarnessFailure("turn_timeout");
  }, async () => {
    unsubscribe();
    if (submitted && !settled) await client.request("cloudCommands.request",
      commandRequest({ kind: "stop", conversationId: input.conversationId, operationId: randomUUID() }, cloudTurnProtocolVersion));
  }, input.timeoutMs ?? 90_000);
}
