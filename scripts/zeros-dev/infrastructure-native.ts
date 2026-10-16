import { createHash, randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { CloudAgentBootScopeSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { cloudOutgoing } from "../../apps/desktop/src/renderer/platform/bridge/cloud-runtime-wire";
import { cloudWorkspaceKey } from "../../apps/desktop/src/renderer/platform/bridge/cloud-workspace-key";
import { bridgePtyCreate, bridgePtyKill, bridgePtyWrite, subscribeBridgePtyData,
  subscribeBridgePtyExit } from "../../apps/desktop/src/renderer/platform/bridge/pty-bridge";
import type { RuntimeExecutionIdentity } from "../../apps/desktop/src/renderer/platform/bridge/runtime-client";
import type { RunHandle } from "./receipts";
import type { ZerosDevRuntime } from "./runtime";
import { ZerosDevError } from "./errors";
import type { NativeProofObservation } from "./native-proof-observation";
import { beforeDeadline } from "./transport";

const MAX_BYTES = 64 * 1024, MAX_TASK_MS = 40 * 60_000, MIN_TASK_MS = 30 * 60_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const integer = z.number().int().nonnegative().safe();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const scopeSchema = CloudAgentBootScopeSchema.extend({ authorityEpoch: z.number().int().positive().safe(),
  rootSha256: digest, engineWorkspaceId: z.string().min(1).max(128) }).strict();
type Scope = z.infer<typeof scopeSchema>;
const rowSchema = z.object({ n: integer.max(31), ms: integer.max(MAX_TASK_MS), run: uuid, nonce: uuid }).strict();
const intentSchema = z.object({ version: z.literal(1), kind: z.literal("native-terminal-task"), runId: uuid,
  fixtureSha256: digest, sessionId: z.string().regex(/^zd-infra-[a-f0-9-]{36}$/), nonce: uuid,
  scope: scopeSchema, scopeSha256: digest, programSha256: digest, startedAtMs: integer, deadlineAtMs: integer }).strict();
function intentMatches(value: z.infer<typeof intentSchema>): boolean {
  return value.sessionId === `zd-infra-${value.runId}` && value.scopeSha256 === sha(JSON.stringify(value.scope)) &&
    value.programSha256 === sha(infrastructureNativeProgram(value)) && value.deadlineAtMs === value.startedAtMs + MAX_TASK_MS;
}
export const InfrastructureNativeIntentSchema = intentSchema.refine(intentMatches, "Native intent binding is inconsistent");
export const InfrastructureNativeTaskSchema = intentSchema.extend({ firstRow: rowSchema.extend({ n: z.literal(0), ms: integer.max(10_000) }).strict() }).strict()
  .refine(value => intentMatches(value) && value.firstRow.run === value.runId && value.firstRow.nonce === value.nonce, "Native task binding is inconsistent");
export const InfrastructureNativeProofSchema = z.object({ version: z.literal(1), kind: z.literal("native-terminal-task"),
  scopeSha256: digest, sessionSha256: digest, programSha256: digest, outputSha256: digest,
  rowCount: z.literal(32), taskDurationMs: integer.gt(MIN_TASK_MS).max(MAX_TASK_MS),
  maxHeartbeatGapMs: integer.min(45_000).max(90_000), replayBytes: integer.positive().max(MAX_BYTES), replayTruncated: z.literal(false) }).strict();
export type InfrastructureNativeIntent = z.infer<typeof InfrastructureNativeIntentSchema>;
export type InfrastructureNativeTask = z.infer<typeof InfrastructureNativeTaskSchema>;
export type InfrastructureNativeProof = z.infer<typeof InfrastructureNativeProofSchema>;
const fileSchema = z.object({ programSha256: digest, outputSha256: digest, rows: z.array(rowSchema).length(32) }).strict();
const badProof = (predicate: NativeProofObservation["predicate"]) =>
  new ZerosDevError("detached_proof_incomplete", undefined, undefined, undefined, undefined, undefined, undefined, { predicate });
const directory = (runId: string) => `.zeros-dev-infra-${runId}`;
const python = (program: string) => `printf '%s' '${Buffer.from(program).toString("base64")}' | base64 -d | python3`;

/** A fixed native task, not an agent or agent-transcript substitute. Exclusive
 * output refuses a duplicate execution; every printed row has been fsynced. */
export function infrastructureNativeProgram(value: { runId: string; nonce: string }): string {
  const run = uuid.parse(value.runId), nonce = uuid.parse(value.nonce);
  return `import json,os,pathlib,time
p=pathlib.Path(__file__).parent
s=time.monotonic_ns()
with (p/'rows.jsonl').open('x') as f:
 for n in range(32):
  time.sleep(max(0,s/1e9+n*60-time.monotonic()))
  r={'n':n,'ms':(time.monotonic_ns()-s)//1000000,'run':'${run}','nonce':'${nonce}'}
  line=json.dumps(r,separators=(',',':'))
  f.write(line+'\\n');f.flush();os.fsync(f.fileno())
  print('ZEROS_DEV_NATIVE '+line,flush=True)
 print('ZEROS_DEV_NATIVE_DONE ${nonce}',flush=True)
`;
}

function install(intent: InfrastructureNativeIntent): string {
  const program = Buffer.from(infrastructureNativeProgram(intent)).toString("base64");
  return python(`import base64,os,pathlib
p=pathlib.Path('${directory(intent.runId)}');p.mkdir(mode=0o700)
with (p/'task.py').open('xb') as f:
 f.write(base64.b64decode('${program}'));f.flush();os.fsync(f.fileno())
`);
}
function fileCheck(intent: InfrastructureNativeIntent): string {
  return python(`import hashlib,json,os,pathlib,stat
p=pathlib.Path('${directory(intent.runId)}')
assert stat.S_ISDIR(p.lstat().st_mode)
def read(name):
 fd=os.open(p/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd)
  assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid() and s.st_size<=16384
  b=os.read(fd,16385)
  assert len(b)==s.st_size and os.fstat(fd).st_size==s.st_size
  return b
 finally: os.close(fd)
b=read('rows.jsonl');s=read('task.py')
print('ZEROS_DEV_NATIVE_FILE '+json.dumps({'programSha256':hashlib.sha256(s).hexdigest(),'outputSha256':hashlib.sha256(b).hexdigest(),'rows':[json.loads(x) for x in b.splitlines()]}))
`);
}
function lines(text: string): string[] {
  // The product replay is a serialized terminal grid, not an event log. Rows
  // are narrower than our fixed terminal width; only complete lines count.
  return stripVTControlCharacters(text).split(/\r?\n/).slice(0, -1).map(line => line.trim());
}
function rows(text: string, intent: InfrastructureNativeIntent): z.infer<typeof rowSchema>[] {
  const result: z.infer<typeof rowSchema>[] = [];
  for (const line of lines(text)) if (line.includes("ZEROS_DEV_NATIVE ")) {
    if (!line.startsWith("ZEROS_DEV_NATIVE ")) throw badProof("row_prefix");
    let value: unknown;
    try { value = JSON.parse(line.slice("ZEROS_DEV_NATIVE ".length)); } catch { throw badProof("row_json"); }
    const parsed = rowSchema.safeParse(value);
    if (!parsed.success) throw badProof("row_schema");
    if (parsed.data.run !== intent.runId || parsed.data.nonce !== intent.nonce) throw badProof("row_identity");
    if (parsed.data.n !== result.length) throw badProof("row_sequence");
    result.push(parsed.data);
  }
  return result;
}
function identityMatches(identity: RuntimeExecutionIdentity, scope: Scope): boolean {
  return identity.kind === "cloud" && identity.organizationId === scope.organizationId && identity.workspaceId === scope.workspaceId &&
    identity.generation === scope.generation && identity.engineInstanceId === scope.engineInstanceId && identity.authorityEpoch === scope.authorityEpoch &&
    !!identity.bootScope && Object.keys(CloudAgentBootScopeSchema.shape).every(key =>
      identity.bootScope![key as keyof typeof identity.bootScope] === scope[key as keyof Scope]);
}

/** Ordinary shared product PTY only. The caller owns disconnect/reconnect and
 * its independently measured detached window, persisted task and first failure.
 * persistIntent must atomically refuse a second intent for the signed run. */
export class InfrastructureNative {
  private began = false;
  constructor(private readonly runtime: Pick<ZerosDevRuntime, "client" | "scope" | "terminal">,
    private readonly handle: RunHandle,
    private readonly options: { persistIntent(intent: InfrastructureNativeIntent): Promise<void> }) {}

  private scope(): Scope {
    const boot = this.runtime.client.activatedCloudAgentBootBinding, target = this.runtime.scope;
    if (!boot || this.runtime.client.status !== "connected" || boot.workspaceId !== this.handle.run.create?.result?.id ||
      boot.organizationId !== target.organizationId || boot.workspaceId !== target.workspaceId ||
      typeof target.root !== "string" || !target.root.startsWith("/") || target.root.includes("\0")) throw new ZerosDevError("runtime_changed");
    const parsed = scopeSchema.safeParse({ ...Object.fromEntries(Object.keys(CloudAgentBootScopeSchema.shape).map(key => [key, boot[key as keyof typeof boot]])),
      authorityEpoch: boot.authorityEpoch, rootSha256: sha(target.root), engineWorkspaceId: target.engineWorkspaceId });
    if (!parsed.success || !identityMatches(this.runtime.client.executionIdentity, parsed.data)) throw new ZerosDevError("runtime_changed");
    return parsed.data;
  }
  private async guarded<T>(scope: Scope, signal: AbortSignal, ms: number,
    work: (bound: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
    const changed = new AbortController(); let invalidated = false;
    const off = this.runtime.client.onExecutionIdentityChange(identity => {
      if (!identityMatches(identity, scope)) { invalidated = true; changed.abort(); }
    });
    const bound = AbortSignal.any([signal, changed.signal, AbortSignal.timeout(Math.max(0, ms))]);
    const check = () => {
      if (invalidated || JSON.stringify(this.scope()) !== JSON.stringify(scope)) throw new ZerosDevError("runtime_changed");
      if (bound.aborted) throw new ZerosDevError("deadline");
    };
    try { check(); const result = await work(bound, check); check(); return result; }
    catch (error) {
      if (invalidated) throw new ZerosDevError("runtime_changed");
      throw error instanceof ZerosDevError ? error : new ZerosDevError("command_uncertain");
    } finally { off(); }
  }
  private observe(sessionId: string) {
    let text = "", prefix = "", seeded = false, failure: ZerosDevError | undefined;
    let notify: (() => void) | undefined;
    const off = [subscribeBridgePtyData(this.runtime.client, event => {
      if (event.sessionId !== sessionId) return;
      if (typeof event.data !== "string" || Buffer.byteLength(prefix) + Buffer.byteLength(text) + Buffer.byteLength(event.data) > MAX_BYTES) failure ??= badProof("output_limit");
      else text += event.data;
      notify?.();
    }), subscribeBridgePtyExit(this.runtime.client, event => {
      if (event.sessionId === sessionId) { failure ??= badProof("pty_exit"); notify?.(); }
    })];
    const read = () => { if (failure) throw failure; return prefix + text; };
    return {
      seed(value: string) {
        if (seeded) throw badProof("replay_seed");
        if (Buffer.byteLength(value) + Buffer.byteLength(text) > MAX_BYTES) throw badProof("output_limit");
        prefix = value; seeded = true; notify?.();
      },
      read,
      async wait<T>(ready: (text: string) => T | undefined, signal: AbortSignal): Promise<T> {
        for (;;) {
          if (signal.aborted) throw new ZerosDevError("deadline");
          const result = seeded ? ready(read()) : undefined;
          if (result !== undefined) return result;
          await beforeDeadline(new Promise<void>(resolve => { notify = resolve; }), signal);
          notify = undefined;
        }
      },
      close() { for (const release of off) release(); notify = undefined; },
    };
  }
  private intent(value: InfrastructureNativeIntent | InfrastructureNativeTask): InfrastructureNativeIntent {
    // Task is an explicitly different strict schema; never strip unknown keys
    // to accept a caller's malformed receipt.
    const parsed = "firstRow" in value ? InfrastructureNativeTaskSchema.safeParse(value) : InfrastructureNativeIntentSchema.safeParse(value);
    if (!parsed.success || parsed.data.runId !== this.handle.run.runId || parsed.data.fixtureSha256 !== this.handle.run.fixtureSha256)
      throw new ZerosDevError("receipt_invalid");
    return parsed.data;
  }

  async begin(signal: AbortSignal): Promise<InfrastructureNativeTask> {
    if (this.began) throw new ZerosDevError("operation_conflict");
    this.began = true;
    if (this.handle.run.cleanupOnly || this.handle.run.cleanupRecovery || this.handle.run.deletionConfirmed) throw new ZerosDevError("forbidden");
    const scope = this.scope(), startedAtMs = Date.now(), runId = this.handle.run.runId, nonce = randomUUID();
    const intent = InfrastructureNativeIntentSchema.parse({ version: 1, kind: "native-terminal-task", runId,
      fixtureSha256: this.handle.run.fixtureSha256, sessionId: `zd-infra-${runId}`, nonce, scope, scopeSha256: sha(JSON.stringify(scope)),
      programSha256: sha(infrastructureNativeProgram({ runId, nonce })), startedAtMs, deadlineAtMs: startedAtMs + MAX_TASK_MS });
    return this.guarded(scope, signal, 60_000, async (bound, check) => {
      try { await beforeDeadline(this.options.persistIntent(InfrastructureNativeIntentSchema.parse(intent)), bound); }
      catch (error) { throw error instanceof ZerosDevError ? error : new ZerosDevError("receipt_invalid"); }
      check();
      const installed = await beforeDeadline(this.runtime.terminal(this.handle, { id: runId, script: install(intent) }, bound), bound);
      check();
      if (installed.exitCode !== 0 || installed.truncated) throw new ZerosDevError("terminal_failed");
      const observed = this.observe(intent.sessionId);
      try {
        observed.seed("");
        const mapped = cloudOutgoing(this.runtime.scope, { type: "PTY_CREATE", cwd: cloudWorkspaceKey(this.runtime.scope) });
        const created = await beforeDeadline(bridgePtyCreate(this.runtime.client, { sessionId: intent.sessionId, cwd: String(mapped.cwd), cols: 240, rows: 80 }), bound);
        check();
        if (!created || created.reattached !== false || created.cwd !== this.runtime.scope.root) throw new ZerosDevError("command_uncertain");
        bridgePtyWrite(this.runtime.client, { sessionId: intent.sessionId, data: `stty -echo; python3 '${directory(runId)}/task.py'\n` });
        const firstRow = await observed.wait(text => {
          const found = rows(text, intent);
          if (found.length > 1 || lines(text).some(line => line.startsWith("ZEROS_DEV_NATIVE_DONE "))) throw badProof("begin_output");
          return found[0];
        }, bound);
        check();
        const task = InfrastructureNativeTaskSchema.safeParse({ ...intent, firstRow });
        if (!task.success) throw badProof("begin_row");
        return task.data;
      } finally { observed.close(); }
    });
  }

  async finish(value: InfrastructureNativeTask, signal: AbortSignal): Promise<InfrastructureNativeProof> {
    const parsed = InfrastructureNativeTaskSchema.safeParse(value);
    if (!parsed.success) throw new ZerosDevError("receipt_invalid");
    const task = parsed.data, intent = this.intent(task), left = intent.deadlineAtMs - Date.now();
    if (left <= 0) throw new ZerosDevError("deadline");
    if (Date.now() - intent.startedAtMs <= MIN_TASK_MS) throw badProof("elapsed_window");
    return this.guarded(intent.scope, signal, Math.min(left, 120_000), async (bound, check) => {
      const observed = this.observe(intent.sessionId);
      try {
        const mapped = cloudOutgoing(this.runtime.scope, { type: "PTY_CREATE", cwd: cloudWorkspaceKey(this.runtime.scope) });
        const created = await beforeDeadline(bridgePtyCreate(this.runtime.client, { sessionId: intent.sessionId, cwd: String(mapped.cwd), cols: 240, rows: 80 }), bound);
        check();
        // Scope/deadline still win; otherwise preserve an observer failure
        // that arrived before this reply or its replay can be classified.
        observed.read();
        // The shared bridge returns null for a refused/failed request. Keep
        // that distinguishable from valid reattach output without its body.
        if (!created) throw badProof("pty_create_unavailable");
        if (created.reattached !== true) throw badProof("pty_not_reattached");
        if (created.cwd !== this.runtime.scope.root) throw badProof("pty_cwd");
        if (created.replayTruncated !== false) throw badProof("replay_truncated");
        if (typeof created.replay !== "string" || !created.replay.length) throw badProof("replay_missing");
        if (created.replayBytes !== Buffer.byteLength(created.replay) || created.replayBytes > MAX_BYTES) throw badProof("replay_bytes");
        observed.seed(created.replay);
        // The first row must be present in the replay itself, not supplied by a
        // new command or a later live write after reconnect.
        if (JSON.stringify(rows(created.replay, intent)[0]) !== JSON.stringify(task.firstRow)) throw badProof("replay_first_row");
        const complete = await observed.wait(text => lines(text).some(line => line === `ZEROS_DEV_NATIVE_DONE ${intent.nonce}`) ? text : undefined, bound);
        const samples = rows(complete, intent);
        if (samples.length !== 32) throw badProof("row_count");
        if (lines(complete).filter(line => line.startsWith("ZEROS_DEV_NATIVE_DONE ")).length !== 1) throw badProof("completion_marker");
        if (JSON.stringify(samples[0]) !== JSON.stringify(task.firstRow)) throw badProof("first_row");
        const gaps = samples.slice(1).map((row, index) => row.ms - samples[index]!.ms);
        if (gaps.some(gap => gap < 45_000 || gap > 90_000)) throw badProof("heartbeat_gap");
        const taskDurationMs = samples[31]!.ms - samples[0]!.ms;
        if (taskDurationMs <= MIN_TASK_MS) throw badProof("task_duration");
        check();
        const file = await beforeDeadline(this.runtime.terminal(this.handle, { script: fileCheck(intent) }, bound), bound);
        check();
        const finalText = observed.read();
        if (JSON.stringify(rows(finalText, intent)) !== JSON.stringify(samples) ||
          lines(finalText).filter(line => line.startsWith("ZEROS_DEV_NATIVE_DONE ")).length !== 1) throw badProof("output_changed");
        if (file.exitCode !== 0 || file.truncated || Buffer.byteLength(file.output) > MAX_BYTES) throw badProof("file_output");
        const candidates = lines(file.output).filter(line => line.startsWith("ZEROS_DEV_NATIVE_FILE "));
        if (candidates.length !== 1) throw badProof("file_marker");
        let decoded: unknown;
        try { decoded = JSON.parse(candidates[0]!.slice("ZEROS_DEV_NATIVE_FILE ".length)); } catch { throw badProof("file_json"); }
        const result = fileSchema.safeParse(decoded), outputSha256 = sha(samples.map(row => JSON.stringify(row) + "\n").join(""));
        if (!result.success) throw badProof("file_schema");
        if (result.data.programSha256 !== intent.programSha256) throw badProof("program_hash");
        if (result.data.outputSha256 !== outputSha256) throw badProof("output_hash");
        if (JSON.stringify(result.data.rows) !== JSON.stringify(samples)) throw badProof("file_rows");
        return InfrastructureNativeProofSchema.parse({ version: 1, kind: "native-terminal-task", scopeSha256: intent.scopeSha256,
          sessionSha256: sha(intent.sessionId), programSha256: intent.programSha256, outputSha256, rowCount: 32, taskDurationMs,
          maxHeartbeatGapMs: Math.max(...gaps), replayBytes: created.replayBytes, replayTruncated: false });
      } finally { observed.close(); }
    });
  }

  /** Called only after the caller has persisted proof or its first failure.
   * An uncertain cleanup is left for the normal product workspace lifecycle. */
  async cleanup(value: InfrastructureNativeTask | InfrastructureNativeIntent, signal: AbortSignal): Promise<void> {
    const intent = this.intent(value);
    await this.guarded(intent.scope, signal, 10_000, async (bound, check) => {
      let resolve!: (value: boolean) => void;
      const ended = new Promise<boolean>(done => { resolve = done; });
      const off = subscribeBridgePtyExit(this.runtime.client, event => { if (event.sessionId === intent.sessionId) resolve(!event.reason); });
      try {
        check(); bridgePtyKill(this.runtime.client, { sessionId: intent.sessionId });
        if (!await beforeDeadline(ended, bound)) throw new ZerosDevError("command_uncertain");
      } finally { off(); }
    });
  }
}
