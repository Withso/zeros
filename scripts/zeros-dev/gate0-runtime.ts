import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CloudBootCommandEntrySchema, CloudBootCommandSnapshotSchema } from "@zeros/protocol/cloud-commands";
import { CloudEventCursorSchema, CloudEventReplayResultSchema, CloudTurnOutcomeSchema } from "@zeros/protocol/cloud-events";
import { RELEASE_CANARY_SMOKE_MODELS } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import type { RunHandle } from "./receipts";
import type { ZerosDevRuntime } from "./runtime";
import type { ProductApi } from "./product";
import { ZerosDevError } from "./errors";
import { beforeDeadline } from "./transport";
import { GATE0_DETACHED_MS, type ModelEligibility } from "./gate0-contract";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const messages = z.array(z.object({ msgId: z.string().min(1).max(128), kind: z.string().max(64),
  payload: z.string().max(512 * 1024), createdAt: z.number().finite() }).strict()).max(200);
const snapshotSchema = z.object({ cursor: CloudEventCursorSchema, snapshot: z.object({
  conversationId: z.string().uuid(), executionId: z.string().nullable(), messages,
  activeTurn: z.object({ turnId: z.string(), startedAt: z.number() }).nullable(),
  latestTurn: CloudTurnOutcomeSchema.nullable().optional(), permissions: z.array(z.unknown()).max(32), questions: z.array(z.unknown()).max(32),
}) });
type Snapshot = z.infer<typeof snapshotSchema>;
type Prompt = RunHandle["run"]["prompts"][number];
export type DetachedTask = {
  prompt: Prompt; commandId: string; executionId: string; generation: number; scopeSha256: string;
  before: Snapshot; program: string; directory: string; completion: Promise<Prompt>;
};
const sleep = async (ms: number, signal: AbortSignal) => {
  try { await delay(ms, undefined, { signal }); } catch { throw new ZerosDevError("deadline"); }
};

export function taskProgram(): string {
  // This fixture produces bounded, VM-monotonic evidence of continuing work.
  // A second execution refuses the exclusive output rather than overwriting it.
  return `import json,os,pathlib,time
p=pathlib.Path(__file__).parent
s=time.monotonic_ns()
with (p/'long.jsonl').open('x') as f:
 for n in range(32):
  time.sleep(max(0,s/1e9+n*60-time.monotonic()))
  f.write(json.dumps({'n':n,'ms':(time.monotonic_ns()-s)//1000000,'run':p.name})+'\\n')
  f.flush();os.fsync(f.fileno())
print('ZEROS_DEV_LONG_OK')
`;
}

export function parseTaskProof(output: string) {
  // Shell startup text is not evidence. Read one exact, size-bounded sentinel.
  const lines = output.split(/\r?\n/).filter(line => line.startsWith("ZEROS_DEV_PROOF "));
  const schema = z.object({ durationMs: z.number().int().nonnegative().safe(), heartbeatCount: z.literal(32),
    maxHeartbeatGapMs: z.number().int().nonnegative().max(90_000) }).strict();
  try {
    if (lines.length !== 1 || lines[0]!.length > 512) throw new Error();
    const value = schema.parse(JSON.parse(lines[0]!.slice("ZEROS_DEV_PROOF ".length)));
    if (value.durationMs < GATE0_DETACHED_MS) throw new Error();
    return value;
  } catch { throw new ZerosDevError("detached_proof_incomplete"); }
}

/** Product reads and the same native conversation adapter as the desktop.
 * There is no provider SSH, DB write, fabricated approval or replayed prompt. */
export class Gate0Runtime {
  constructor(readonly runtime: ZerosDevRuntime, private readonly api: ProductApi, private readonly handle: RunHandle,
    private readonly pause = sleep) {}

  private binding() {
    const scope = this.runtime.client.activatedCloudAgentBootBinding, identity = this.runtime.client.executionIdentity;
    if (!scope || identity.kind !== "cloud" || scope.workspaceId !== this.handle.run.create?.result?.id ||
      scope.organizationId !== this.runtime.scope.organizationId || scope.generation !== identity.generation ||
      scope.engineInstanceId !== identity.engineInstanceId || scope.authorityEpoch !== identity.authorityEpoch)
      throw new ZerosDevError("runtime_changed");
    return scope;
  }
  private scopeHash(): string {
    const scope = this.binding();
    return hash([scope.organizationId, scope.workspaceId, scope.generation, scope.engineInstanceId, scope.authorityEpoch,
      scope.bootId, scope.writerEpoch, scope.fundingOwnerUserId, scope.fundingOwnerEpoch]);
  }
  private async read(op: "cloudCommands.request" | "cloudEvents.request", request: object, signal: AbortSignal): Promise<unknown> {
    const binding = this.binding();
    const params = op === "cloudCommands.request" ? { request, nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1,
      cloudLocalCommandsVersion: 1, bootId: binding.bootId, writerEpoch: binding.writerEpoch } : { request };
    const response = await beforeDeadline(this.runtime.client.request({ type: "WORKSPACE_REQUEST", op, params }, { signal, timeoutMs: 15_000 }), signal);
    if (response.type !== "WORKSPACE_RESPONSE" || response.op !== op || "error" in response && response.error) throw new ZerosDevError("bad_response");
    return (response as { result?: unknown }).result;
  }
  private async snapshot(prompt: Prompt, signal: AbortSignal): Promise<Snapshot> {
    const parsed = snapshotSchema.safeParse(await this.read("cloudEvents.request", { kind: "snapshot", conversationId: prompt.conversationId }, signal));
    if (!parsed.success || parsed.data.snapshot.conversationId !== prompt.conversationId ||
      new Set(parsed.data.snapshot.messages.map(row => row.msgId)).size !== parsed.data.snapshot.messages.length)
      throw new ZerosDevError("bad_response");
    return parsed.data;
  }
  async models(signal: AbortSignal): Promise<ModelEligibility[]> {
    const before = this.scopeHash(), scope = this.binding();
    const availability = await this.api.agentAvailability(this.handle.run, signal);
    const reply = await this.runtime.client.request({ type: "AGENT_LIST_AGENTS" }, { timeoutMs: 30_000, signal });
    const registry = z.object({ type: z.literal("AGENT_AGENTS_LIST"), agents: z.array(z.object({ id: z.string().max(64),
      installed: z.boolean().optional(), launchKind: z.string().optional(), runtimeUnavailableReason: z.string().optional() })).max(128) }).safeParse(reply);
    if (!registry.success || before !== this.scopeHash() || availability.mode !== "boot-owner-v1" || availability.status !== "ready" ||
      (["generation", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const).some(key => availability.scope[key] !== scope[key]))
      throw new ZerosDevError("model_eligibility_unconfirmed");
    const result = (["claude", "codex", "cursor"] as const).map(agent => {
      const installed = registry.data.agents.filter(row => row.id === agent), slots = availability.providers.filter(row => row.provider === agent);
      const slot = slots.length === 1 ? slots[0] : undefined;
      const allowed = slot?.status === "ready" ? [...new Set(slot.models ?? [])] : [];
      const selectedModel = RELEASE_CANARY_SMOKE_MODELS[agent];
      return { agent, selectedModel, allowedCount: allowed.length, unavailableCount: slot?.status === "ready" ? 0 : 1,
        eligible: installed.length === 1 && installed[0]!.installed === true && installed[0]!.launchKind !== "unavailable" &&
          !installed[0]!.runtimeUnavailableReason && allowed.includes(selectedModel), scopeSha256: before };
    });
    if (result.some(row => !row.eligible)) throw new ZerosDevError("model_eligibility_unconfirmed");
    return result;
  }

  async begin(signal: AbortSignal): Promise<DetachedTask> {
    const directory = `.zeros-dev-${this.handle.run.runId}`, program = taskProgram(), scopeSha256 = this.scopeHash();
    const installed = await this.runtime.terminal(this.handle, { script:
      `set -eu; mkdir -p '${directory}'; printf '%s' '${Buffer.from(program).toString("base64")}' | base64 -d > '${directory}/long.py'` }, signal);
    if (installed.exitCode !== 0 || installed.truncated) throw new ZerosDevError("terminal_failed");
    const { receipt: prompt, completion } = await this.runtime.startPrompt(this.handle, { id: randomUUID(), agent: "codex",
      model: RELEASE_CANARY_SMOKE_MODELS.codex, permissionMode: "auto", text:
      `Run python3 ${directory}/long.py in the foreground and wait until it exits (about 31 minutes). Use a long-running shell session and await it until exit; do not background it or finish early. Do not edit the script, output or any other file. Do not use the network. On exit, reply exactly ZEROS_DEV_LONG_OK.` }, signal);
    let completed = false, failure: unknown;
    void completion.then(() => { completed = true; }, error => { failure = error; });
    for (let n = 0; n < 90; n++) {
      if (signal.aborted) throw new ZerosDevError("deadline");
      if (failure) throw failure;
      if (completed) throw new ZerosDevError("detached_task_not_active");
      const parsed = CloudBootCommandSnapshotSchema.safeParse(await this.read("cloudCommands.request", { kind: "snapshot", conversationId: prompt.conversationId }, signal));
      if (!parsed.success || parsed.data.conversationId !== prompt.conversationId) throw new ZerosDevError("bad_response");
      const matching = [...parsed.data.pending, ...parsed.data.receipts].filter(row => row.payload?.userMessageId === prompt.id);
      if (matching.length > 1) throw new ZerosDevError("detached_proof_incomplete");
      const entry = matching[0];
      if (entry && ["succeeded", "failed", "cancelled", "uncertain"].includes(entry.state)) throw new ZerosDevError("detached_task_not_active");
      if (entry?.state === "dispatching" && entry.executionId) {
        if (entry.generation !== this.binding().generation || entry.payload?.agentId !== prompt.agent || entry.payload.model !== prompt.model)
          throw new ZerosDevError("detached_proof_incomplete");
        let before = await this.snapshot(prompt, signal);
        if (before.snapshot.permissions.length || before.snapshot.questions.length) throw new ZerosDevError("permission_required");
        if (before.snapshot.executionId === entry.executionId && before.snapshot.activeTurn?.turnId === prompt.id) {
          // Admission alone does not prove the long task has begun. Bound the
          // passive file probes so neither an idle agent nor a short command
          // can satisfy the laptop-close scenario.
          const check = `import json,pathlib
p=pathlib.Path('${directory}/long.jsonl')
r=[json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []
if 0<len(r)<32 and r[0]['n']==0: print('ZEROS_DEV_ACTIVE')
`;
          let started = false;
          for (let probe = 0; probe < 6; probe++) {
            const result = await this.runtime.terminal(this.handle, { script: `printf '%s' '${Buffer.from(check).toString("base64")}' | base64 -d | python3` }, signal);
            if (result.exitCode !== 0 || result.truncated) throw new ZerosDevError("detached_task_not_active");
            if (result.output.split(/\r?\n/).filter(line => line === "ZEROS_DEV_ACTIVE").length === 1) { started = true; break; }
            if (probe < 5) await this.pause(5000, signal);
          }
          if (!started || completed || failure) throw new ZerosDevError("detached_task_not_active");
          before = await this.snapshot(prompt, signal);
          if (before.snapshot.executionId !== entry.executionId || before.snapshot.activeTurn?.turnId !== prompt.id ||
            before.snapshot.permissions.length || before.snapshot.questions.length) throw new ZerosDevError("detached_task_not_active");
          if (scopeSha256 !== this.scopeHash()) throw new ZerosDevError("runtime_changed");
          return { prompt, commandId: entry.commandId, executionId: entry.executionId, generation: entry.generation,
            scopeSha256, before, program, directory, completion };
        }
      }
      await this.pause(1000, signal);
    }
    throw new ZerosDevError("detached_task_not_active");
  }

  async finish(task: DetachedTask, signal: AbortSignal) {
    if (task.scopeSha256 !== this.scopeHash()) throw new ZerosDevError("runtime_changed");
    const schema = CloudBootCommandEntrySchema.extend({ conversationId: z.string().uuid() });
    let settled = false;
    for (let n = 0; n < 150; n++) {
      const parsed = schema.safeParse(await this.read("cloudCommands.request", { kind: "read", commandId: task.commandId }, signal));
      if (!parsed.success) throw new ZerosDevError("bad_response");
      const row = parsed.data;
      if (row.commandId !== task.commandId || row.conversationId !== task.prompt.conversationId || row.executionId !== task.executionId || row.generation !== task.generation)
        throw new ZerosDevError("detached_proof_incomplete");
      if (row.state === "succeeded") {
        const terminal = row.result?.terminal;
        if (!terminal || terminal.status !== "completed" || terminal.stopReason !== "end_turn" || terminal.commandId !== task.commandId ||
          terminal.conversationId !== task.prompt.conversationId || terminal.turnId !== task.prompt.id || terminal.executionId !== task.executionId || terminal.agentId !== "codex")
          throw new ZerosDevError("detached_proof_incomplete");
        settled = true; break;
      }
      if (row.state !== "dispatching") throw new ZerosDevError("agent_failed");
      await this.pause(1000, signal);
    }
    if (!settled) throw new ZerosDevError("deadline");
    const after = await this.snapshot(task.prompt, signal), { snapshot } = after;
    if (snapshot.activeTurn || snapshot.executionId !== null && snapshot.executionId !== task.executionId || snapshot.latestTurn?.turnId !== task.prompt.id ||
      snapshot.latestTurn.executionId !== task.executionId || snapshot.latestTurn.commandId !== task.commandId ||
      snapshot.latestTurn.status !== "completed" || snapshot.permissions.length || snapshot.questions.length ||
      !snapshot.messages.some(row => { try { const value = JSON.parse(row.payload); return value.role === "assistant" && value.text?.trim() === "ZEROS_DEV_LONG_OK"; } catch { return false; } }))
      throw new ZerosDevError("detached_proof_incomplete");
    const prefix = task.before.snapshot.messages.filter(row => { try { return JSON.parse(row.payload).role === "user"; } catch { return false; } });
    if (!prefix.length || task.before.snapshot.messages.some(row => !snapshot.messages.some(value =>
      value.msgId === row.msgId && value.kind === row.kind && value.createdAt === row.createdAt)) ||
      prefix.some(row => !snapshot.messages.some(value => value.msgId === row.msgId && hash(value) === hash(row))))
      throw new ZerosDevError("history_changed");
    let cursor = task.before.cursor, replayEvents = 0, terminalSeen = false;
    if (cursor.streamId !== after.cursor.streamId || cursor.sequence >= after.cursor.sequence) throw new ZerosDevError("detached_proof_incomplete");
    for (let page = 0; page < 64 && cursor.sequence < after.cursor.sequence; page++) {
      const parsed = CloudEventReplayResultSchema.safeParse(await this.read("cloudEvents.request", { kind: "replay", cursor }, signal));
      if (!parsed.success) throw new ZerosDevError("bad_response");
      const value = parsed.data;
      if (value.streamId !== cursor.streamId || value.firstRetained > cursor.sequence + 1 || value.cursor <= cursor.sequence ||
        value.events.some((event, index) => event.sequence !== cursor.sequence + index + 1) || value.events.at(-1)?.sequence !== value.cursor)
        throw new ZerosDevError("detached_proof_incomplete");
      for (const { sequence, frame } of value.events) if (sequence <= after.cursor.sequence) {
        replayEvents++;
        if (frame.type === "AGENT_PROMPT_COMPLETE" && frame.requestId === task.commandId &&
          (frame.chatId === undefined || frame.chatId === task.prompt.conversationId) &&
          (frame.executionId ?? frame.sessionId) === task.executionId && frame.agentId === "codex") terminalSeen = true;
      }
      cursor = { streamId: cursor.streamId, sequence: value.cursor };
    }
    if (cursor.sequence < after.cursor.sequence || !terminalSeen) throw new ZerosDevError("detached_proof_incomplete");
    const programSha = createHash("sha256").update(task.program).digest("hex");
    const check = `import hashlib,json,pathlib
p=pathlib.Path('${task.directory}')
assert hashlib.sha256((p/'long.py').read_bytes()).hexdigest()=='${programSha}'
r=[json.loads(x) for x in (p/'long.jsonl').read_text().splitlines()]
assert len(r)==32 and all(x['n']==i and x['run']==p.name for i,x in enumerate(r))
g=[b['ms']-a['ms'] for a,b in zip(r,r[1:])]
assert min(g)>=45000
print('ZEROS_DEV_PROOF '+json.dumps({'durationMs':r[-1]['ms']-r[0]['ms'],'heartbeatCount':len(r),'maxHeartbeatGapMs':max(g)}))
`;
    const proof = await this.runtime.terminal(this.handle, { script: `printf '%s' '${Buffer.from(check).toString("base64")}' | base64 -d | python3` }, signal);
    if (proof.exitCode !== 0 || proof.truncated) throw new ZerosDevError("detached_proof_incomplete");
    const checked = parseTaskProof(proof.output);
    if (task.scopeSha256 !== this.scopeHash()) throw new ZerosDevError("runtime_changed");
    const prompt = this.handle.run.prompts.find(row => row.id === task.prompt.id);
    if (!prompt || prompt.conversationId !== task.prompt.conversationId) throw new ZerosDevError("receipt_invalid");
    prompt.state = "succeeded"; await this.handle.save();
    return { ...checked, commandSha256: hash([task.commandId, task.prompt.id, task.executionId]), scopeSha256: task.scopeSha256,
      historySha256: hash(snapshot.messages), historyRows: snapshot.messages.length, replayEvents, cursorSha256: hash([task.before.cursor, after.cursor]) };
  }
}
