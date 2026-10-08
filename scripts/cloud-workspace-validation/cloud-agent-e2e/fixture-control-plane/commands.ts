import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CLOUD_COMMAND_FAILURE_STAGES, CloudCommandClientRequestSchema, CloudCommandClaimSchema, CloudCommandEntrySchema,
  CloudCommandMutationSchema, CloudCommandSnapshotSchema, CloudNativeResultSchema, decodeCloudCommandFailure, legacyCloudCommandResponse,
  type CloudCommandSnapshot } from "@zeros/protocol/cloud-commands";
import type { CloudCommandActor } from "@zeros/protocol/cloud-actors";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import { canonical, clone, FixtureRefusal, parse, ScopeSchema, sha256 } from "./contracts";

const identity = CloudCommandSnapshotSchema.shape.conversationId;
const SettleSchema = z.object({ commandId: z.uuid(), claimId: z.uuid(), state: z.enum(["succeeded", "failed", "cancelled"]),
  resultCode: CloudCommandEntrySchema.shape.resultCode.refine(code => code === null ||
    !CLOUD_COMMAND_FAILURE_STAGES.some(stage => code.startsWith(`cloud_${stage}_`)) || decodeCloudCommandFailure(code) !== null),
  result: CloudNativeResultSchema.optional() }).strict();
const RequestSchema = z.union([
  CloudCommandClientRequestSchema.options[0], CloudCommandClientRequestSchema.options[1], CloudCommandClientRequestSchema.options[3],
  z.object({ kind: z.literal("mutate"), mutation: CloudCommandMutationSchema,
    admissionError: z.enum(["command_context_changed", "command_not_found"]).nullable().optional() }).strict(),
  z.object({ kind: z.literal("claim"), conversationId: identity, executionId: identity, claimId: z.uuid().optional() }).strict(),
  z.object({ kind: z.literal("settle"), result: SettleSchema }).strict(),
]);
export const CommandBodySchema = ScopeSchema.extend({ request: RequestSchema, actorSessionId: z.uuid().optional() }).strict();
type Entry = z.infer<typeof CloudCommandEntrySchema>;
type StoredCommand = { entry: Entry; conversationId: string; claimId: string | null; actor: CloudCommandActor; sourceSessionId: string;
  agentId: string; settlement?: { state: string; resultCode: string | null } };
type Control = { revision: number; paused: boolean; nextPosition: number };

/** Matches the CP's receipt ledger: claims never expire into runnable work. */
export class FixtureCommands {
  private readonly controls = new Map<string, Control>();
  private readonly commands = new Map<string, StoredCommand>();
  private readonly operations = new Map<string, string>();
  constructor(private readonly dependencies: { now(): number; generation: number;
    requireActor(sessionId: string | undefined): CloudCommandActor; recordedActorLive(): boolean; sourceSessionId: string }) {}

  private control(conversationId: string): Control {
    let control = this.controls.get(conversationId);
    if (!control) {
      if (this.controls.size >= 10_000) throw new FixtureRefusal("command_limit", 422);
      control = { revision: 0, paused: false, nextPosition: 1 }; this.controls.set(conversationId, control);
    }
    return control;
  }
  snapshot(conversationId: string, replayed?: boolean): CloudCommandSnapshot {
    const control = this.control(conversationId);
    const rows = [...this.commands.values()].filter(row => row.conversationId === conversationId).map(row => row.entry);
    return CloudCommandSnapshotSchema.parse({ version: 1, conversationId, revision: control.revision, paused: control.paused,
      pending: rows.filter(row => row.state === "queued" || row.state === "dispatching").sort((a, b) => a.position - b.position),
      receipts: rows.filter(row => row.state !== "queued" && row.state !== "dispatching").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.commandId.localeCompare(a.commandId)).slice(0, 50)
        .map(row => ({ ...row, payload: null })), ...(replayed === undefined ? {} : { replayed }) });
  }
  read(commandId: string) {
    const row = this.commands.get(commandId);
    if (!row) throw new FixtureRefusal("command_not_found", 404);
    return clone({ ...row.entry, conversationId: row.conversationId });
  }
  terminalReceipt(commandId: string) {
    const entry = this.read(commandId), row = this.commands.get(commandId)!;
    // CP preserves a recorded admission denial when an older engine settles
    // generically. Keep that wire behavior, but never use it as E2E evidence
    // that the engine submitted the correct typed failure.
    if (row.settlement && (row.settlement.state !== entry.state || row.settlement.resultCode !== entry.resultCode))
      throw new Error("fixture_settlement_conflict");
    return { ...entry, agentId: row.agentId };
  }
  claimed(commandId: string, claimId: string, executionId: string): StoredCommand {
    const row = this.commands.get(commandId);
    if (!row || row.claimId !== claimId || row.entry.executionId !== executionId || row.entry.state !== "dispatching" || !row.entry.payload)
      throw new FixtureRefusal("cloud_agent_authority_rejected", 403);
    return clone(row);
  }
  recordDenial(commandId: string, code: string): void {
    const row = this.commands.get(commandId);
    if (row && row.entry.state === "dispatching") row.entry.resultCode = code;
  }
  handle(raw: unknown, actorSessionId: string | undefined, native: boolean, turnProtocol = false): unknown {
    const request = parse(RequestSchema, raw, "invalid_command");
    const result = this.request(request, actorSessionId, native);
    return native && turnProtocol ? result : legacyCloudCommandResponse(result, native ? 1 : undefined);
  }
  private request(request: z.infer<typeof RequestSchema>, actorSessionId: string | undefined, native: boolean): unknown {
    const actor = request.kind === "claim" || request.kind === "settle" ? null : this.dependencies.requireActor(actorSessionId);
    switch (request.kind) {
      case "snapshot": return this.snapshot(request.conversationId);
      case "read": return this.read(request.commandId);
      case "mutate": {
        const mutation = request.mutation, action = mutation.action, control = this.control(mutation.conversationId);
        if (!native && "payload" in action && action.payload.operation) throw new FixtureRefusal("invalid_command", 422);
        const encoded = canonical({ mutation, actor });
        if (Buffer.byteLength(canonical(mutation)) > 192 * 1024) throw new FixtureRefusal("command_limit", 422);
        const hash = sha256(encoded), previous = this.operations.get(mutation.operationId);
        if (previous) {
          if (previous !== hash) throw new FixtureRefusal("command_conflict");
          return this.snapshot(mutation.conversationId, true);
        }
        if (request.admissionError) throw new FixtureRefusal(request.admissionError, request.admissionError === "command_not_found" ? 404 : 409);
        if (control.revision !== mutation.expectedRevision) throw new FixtureRefusal("command_conflict");
        if (this.operations.size >= 200_000) throw new FixtureRefusal("command_limit", 422);
        if (action.kind === "enqueue" || action.kind === "fork") {
          if (this.commands.has(action.commandId)) throw new FixtureRefusal("command_conflict");
          if ([...this.commands.values()].filter(row => row.entry.state === "queued" || row.entry.state === "dispatching").length >= 32 || this.commands.size >= 100_000)
            throw new FixtureRefusal("command_limit", 422);
          const stamp = new Date(this.dependencies.now()).toISOString();
          const entry = CloudCommandEntrySchema.parse({ commandId: action.commandId, position: control.nextPosition++, state: "queued", payload: action.payload,
            executionId: null, generation: this.dependencies.generation, resultCode: null, createdAt: stamp, updatedAt: stamp });
          this.commands.set(action.commandId, { entry: clone(entry), conversationId: mutation.conversationId, claimId: null,
            actor: clone(actor!), sourceSessionId: this.dependencies.sourceSessionId, agentId: action.payload.agentId });
        } else if (action.kind === "pause" || action.kind === "resume") control.paused = action.kind === "pause";
        else {
          const row = this.commands.get(action.commandId);
          if (!row || row.conversationId !== mutation.conversationId || row.entry.state !== "queued" ||
              (action.kind === "edit" && row.entry.payload?.userMessageId !== action.payload.userMessageId)) throw new FixtureRefusal("command_conflict");
          row.entry.payload = action.kind === "edit" ? clone(action.payload) : null;
          if (action.kind === "remove") { row.entry.state = "cancelled"; row.entry.resultCode = "removed_before_dispatch"; }
          else { row.actor = clone(actor!); row.agentId = action.payload.agentId; }
          row.entry.updatedAt = new Date(this.dependencies.now()).toISOString();
        }
        control.revision++; this.operations.set(mutation.operationId, hash);
        return this.snapshot(mutation.conversationId, false);
      }
      case "stop": {
        const control = this.control(request.conversationId), hash = sha256(canonical({ kind: "stop", conversationId: request.conversationId, actor }));
        const previous = this.operations.get(request.operationId);
        if (previous) {
          if (previous !== hash) throw new FixtureRefusal("command_conflict");
          return this.snapshot(request.conversationId, true);
        }
        control.paused = true; control.revision++;
        if (this.operations.size < 200_000) this.operations.set(request.operationId, hash);
        return this.snapshot(request.conversationId, false);
      }
      case "claim": {
        let row = request.claimId ? [...this.commands.values()].find(row => row.claimId === request.claimId) : undefined;
        if (row) {
          if (row.conversationId !== request.conversationId || row.entry.executionId !== request.executionId) throw new FixtureRefusal("command_conflict");
          if (row.entry.state !== "dispatching" || (!native && row.entry.payload?.operation)) return null;
        } else {
          const control = this.control(request.conversationId), rows = [...this.commands.values()].filter(row => row.conversationId === request.conversationId);
          if (rows.some(row => row.entry.state === "dispatching")) return null;
          row = rows.filter(row => row.entry.state === "queued" && (!control.paused || row.entry.payload?.operation?.kind === "goal") &&
            (native || !row.entry.payload?.operation)).sort((a, b) => a.entry.position - b.entry.position)[0];
          if (!row) return null;
          row.claimId = request.claimId ?? randomUUID(); row.entry.executionId = request.executionId; row.entry.state = "dispatching";
          row.entry.updatedAt = new Date(this.dependencies.now()).toISOString(); control.revision++;
        }
        const live = this.dependencies.recordedActorLive();
        return CloudCommandClaimSchema.parse({ commandId: row.entry.commandId, claimId: row.claimId, conversationId: request.conversationId,
          executionId: request.executionId, payload: clone(row.entry.payload!), dispatchAllowed: live, ...(live ? { actor: row.actor } : {}) });
      }
      case "settle": {
        const input = request.result, row = this.commands.get(input.commandId);
        if (!row || row.claimId !== input.claimId) throw new FixtureRefusal("command_conflict");
        const state = isCloudAgentAdmissionCode(row.entry.resultCode) ? "failed" : input.state;
        const code = isCloudAgentAdmissionCode(row.entry.resultCode) ? row.entry.resultCode : input.resultCode;
        if (row.entry.state !== "dispatching") {
          if (row.entry.state !== state || row.entry.resultCode !== code || canonical(row.entry.result ?? null) !== canonical(input.result ?? null))
            throw new FixtureRefusal("command_conflict");
          return this.snapshot(row.conversationId, true);
        }
        row.settlement = { state: input.state, resultCode: input.resultCode };
        row.entry.state = state; row.entry.resultCode = code; row.entry.payload = null;
        if (input.result) row.entry.result = clone(input.result);
        row.entry.updatedAt = new Date(this.dependencies.now()).toISOString(); this.control(row.conversationId).revision++;
        return this.snapshot(row.conversationId, false);
      }
    }
  }
  inspect() { return [...this.commands.values()].map(({ entry, conversationId, claimId, settlement }) => ({ commandId: entry.commandId, conversationId, claimId,
    executionId: entry.executionId, state: entry.state, resultCode: entry.resultCode,
    settlementMatchesReceipt: settlement ? settlement.state === entry.state && settlement.resultCode === entry.resultCode : null })); }
}
