import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CloudBootCommandEntrySchema, CloudBootCommandSnapshotSchema } from "@zeros/protocol/cloud-commands";
import { RELEASE_CANARY_SMOKE_MODELS } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import { Gate0Runtime, parseTaskProof, taskProgram } from "../zeros-dev/gate0-runtime";
import type { RunHandle } from "../zeros-dev/receipts";

function fixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 3, engineInstanceId: randomUUID(),
    authorityEpoch: 2, bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const handle: RunHandle = { run: { version: 1, runId: randomUUID(), fixtureSha256: "a".repeat(64), deviceId: randomUUID(),
    createdAt: "2026-10-14T00:00:00Z", source: { revision: "b".repeat(40), dirty: false }, prompts: [], lifecycle: [], evidence: [], deletionConfirmed: false,
    create: { key: randomUUID(), body: {} as never, result: { id: scope.workspaceId, createdBy: randomUUID(), generation: 3, createdAt: "2026-10-14T00:00:00Z" } } },
    save: vi.fn(async () => {}) };
  const prompt = { id: randomUUID(), conversationId: randomUUID(), agent: "codex" as const, model: RELEASE_CANARY_SMOKE_MODELS.codex,
    sha256: "b".repeat(64), state: "pending" as const };
  handle.run.prompts.push(prompt);
  const commandId = randomUUID(), executionId = randomUUID(), streamId = randomUUID();
  const entry = CloudBootCommandEntrySchema.parse({ commandId, executionId, generation: 3, position: 1, state: "dispatching", resultCode: null,
    payload: { agentId: "codex", userMessageId: prompt.id, prompt: [{ type: "text", text: "synthetic task" }], modeRevision: 0,
      model: prompt.model, permissionMode: "auto-edit" }, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z" });
  const queue = CloudBootCommandSnapshotSchema.parse({ version: 1, conversationId: prompt.conversationId, revision: 1, paused: false, pending: [entry], receipts: [] });
  const terminal = { commandId, conversationId: prompt.conversationId, turnId: prompt.id, executionId, agentId: "codex",
    status: "completed", stopReason: "end_turn" };
  const user = { msgId: prompt.id, kind: "text", payload: JSON.stringify({ role: "user", text: "synthetic task" }), createdAt: 1 };
  const before = { cursor: { streamId, sequence: 100 }, snapshot: { conversationId: prompt.conversationId, executionId,
    activeTurn: { turnId: prompt.id, startedAt: 1 }, latestTurn: null, messages: [user], permissions: [], questions: [] } };
  const after = { cursor: { streamId, sequence: 103 }, snapshot: { ...before.snapshot, activeTurn: null, latestTurn: terminal,
    messages: [user, { msgId: randomUUID(), kind: "text", payload: JSON.stringify({ role: "assistant", text: "ZEROS_DEV_LONG_OK" }), createdAt: 2 }] } };
  // zeros-engine's native terminal has request/execution/agent identity, not
  // chatId. Conversation identity comes from the exact durable command receipt.
  const replay: any = { streamId, head: 103, firstRetained: 0, cursor: 103, events: [
    { sequence: 101, frame: { type: "AGENT_SESSION_UPDATE" } }, { sequence: 102, frame: { type: "DB_CHANGED" } },
    { sequence: 103, frame: { type: "AGENT_PROMPT_COMPLETE", requestId: commandId, executionId, sessionId: executionId,
      agentId: "codex", stopReason: "end_turn", response: { userMessageId: prompt.id, stopReason: "end_turn" } } },
  ] };
  let finished = false;
  const request = vi.fn(async (message: any) => {
    if (message.type === "AGENT_LIST_AGENTS") return { type: "AGENT_AGENTS_LIST", agents: ["claude", "codex", "cursor"].map(id => ({ id, installed: true })) };
    const { op, params } = message;
    if (op === "cloudCommands.request") expect(params).toMatchObject({ nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1,
      cloudLocalCommandsVersion: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch });
    const result = op === "cloudCommands.request"
      ? params.request.kind === "snapshot" ? queue : { ...entry, conversationId: prompt.conversationId, payload: null, state: "succeeded", result: { version: 1, terminal } }
      : params.request.kind === "replay" ? replay : finished ? after : before;
    return { type: "WORKSPACE_RESPONSE", op, result };
  });
  const runtime = { client: { activatedCloudAgentBootBinding: scope, executionIdentity: { ...scope, kind: "cloud" }, request }, scope,
    terminal: vi.fn(async () => ({ exitCode: 0, truncated: false,
      output: finished ? 'ZEROS_DEV_PROOF {"durationMs":1860000,"heartbeatCount":32,"maxHeartbeatGapMs":60000}\n' : "ZEROS_DEV_ACTIVE\n" })),
    startPrompt: vi.fn(async () => ({ receipt: prompt, completion: new Promise<never>(() => {}) })) };
  const availability = { mode: "boot-owner-v1", status: "ready", scope,
    providers: (["claude", "codex", "cursor"] as const).map(provider => ({ provider, status: "ready", models: [RELEASE_CANARY_SMOKE_MODELS[provider]] })) };
  const api = { agentAvailability: vi.fn(async () => availability) }, pause = vi.fn(async () => {});
  const probe = new Gate0Runtime(runtime as never, api as never, handle, pause);
  return { probe, runtime, api, availability, request, scope, before, after, replay, queue, entry, terminal, handle, prompt,
    finish: () => { finished = true; } };
}
const signal = () => new AbortController().signal;

describe("Gate 0 exact native detached-task proof", () => {
  it("binds passive model eligibility and installed native providers to the admitted boot", async () => {
    const f = fixture(); expect(await f.probe.models(signal())).toEqual(["claude", "codex", "cursor"].map(agent =>
      expect.objectContaining({ agent, eligible: true, allowedCount: 1 })));
    f.availability.providers[1]!.models = [];
    await expect(f.probe.models(signal())).rejects.toMatchObject({ code: "model_eligibility_unconfirmed" });
    expect(f.runtime.startPrompt).not.toHaveBeenCalled();
  });
  it("proves the product's terminal frame without inventing a chatId field or reenqueuing", async () => {
    const f = fixture(), task = await f.probe.begin(signal()); f.finish();
    const proof = await f.probe.finish(task, signal());
    expect(proof).toMatchObject({ durationMs: 1_860_000, heartbeatCount: 32, historyRows: 2, replayEvents: 3 });
    expect(f.runtime.startPrompt).toHaveBeenCalledOnce(); expect(f.prompt.state).toBe("succeeded");
    expect(f.request.mock.calls.filter(([message]) => message.params?.request?.kind === "mutate")).toHaveLength(0);
  });
  it("accepts a retired native host only with the exact saved terminal identity", async () => {
    const f = fixture(), task = await f.probe.begin(signal()); f.finish();
    (f.after.snapshot as any).executionId = null;
    await expect(f.probe.finish(task, signal())).resolves.toMatchObject({ historyRows: 2 });
  });
  it("retains every pre-disconnect transcript row while allowing an active row to finish", async () => {
    const f = fixture(), row = { msgId: randomUUID(), kind: "tool", payload: JSON.stringify({ role: "assistant", text: "running" }), createdAt: 1 };
    f.before.snapshot.messages.push(row);
    const task = await f.probe.begin(signal()); f.finish();
    await expect(f.probe.finish(task, signal())).rejects.toMatchObject({ code: "history_changed" });
    f.after.snapshot.messages.push({ ...row, payload: JSON.stringify({ role: "assistant", text: "finished" }) });
    await expect(f.probe.finish(task, signal())).resolves.toMatchObject({ historyRows: 3 });
    expect(f.runtime.startPrompt).toHaveBeenCalledOnce();
  });
  it.each(["boot", "generation", "command", "execution", "turn", "prefix", "replay_gap", "foreign_terminal", "truncated_replay", "short_task"] as const)(
    "refuses %s evidence without a new command", async kind => {
      const f = fixture(), task = await f.probe.begin(signal()); f.finish();
      if (kind === "boot") f.scope.bootId = randomUUID();
      if (kind === "generation") f.entry.generation++;
      if (kind === "command") f.entry.commandId = randomUUID();
      if (kind === "execution") f.terminal.executionId = randomUUID();
      if (kind === "turn") f.terminal.turnId = randomUUID();
      if (kind === "prefix") f.after.snapshot.messages[0] = { ...f.before.snapshot.messages[0]!, payload: "changed" };
      if (kind === "replay_gap") f.replay.events[1].sequence++;
      if (kind === "foreign_terminal") f.replay.events[2].frame.chatId = randomUUID();
      if (kind === "truncated_replay") f.replay.firstRetained = 102;
      if (kind === "short_task") f.runtime.terminal.mockResolvedValue({ exitCode: 0, truncated: false, output: 'ZEROS_DEV_PROOF {"durationMs":30000,"heartbeatCount":32,"maxHeartbeatGapMs":1000}' });
      await expect(f.probe.finish(task, signal())).rejects.toMatchObject({ code: kind === "boot" ? "runtime_changed" : kind === "prefix" ? "history_changed" : "detached_proof_incomplete" });
      expect(f.runtime.startPrompt).toHaveBeenCalledOnce(); expect(f.prompt.state).toBe("pending");
    });
  it("refuses a dispatch from another generation before detaching", async () => {
    const f = fixture(); f.queue.pending[0]!.generation++;
    await expect(f.probe.begin(signal())).rejects.toMatchObject({ code: "detached_proof_incomplete" });
  });
  it("requires a running task heartbeat as well as a dispatching receipt", async () => {
    const f = fixture(); f.runtime.terminal.mockResolvedValue({ exitCode: 0, truncated: false, output: "" });
    await expect(f.probe.begin(signal())).rejects.toMatchObject({ code: "detached_task_not_active" });
  });
  it("keeps permission refusals terminal and never fabricates approval", async () => {
    const f = fixture(); (f.before.snapshot.permissions as any[]).push({ permissionId: "synthetic" });
    await expect(f.probe.begin(signal())).rejects.toMatchObject({ code: "permission_required" });
    expect(f.request.mock.calls.every(([row]) => !row.type.includes("RESPONSE"))).toBe(true);
  });
  it("requires one complete bounded VM proof and a duplicate-safe program", () => {
    expect(taskProgram()).toContain(".open('x')"); expect(taskProgram()).toContain("monotonic_ns");
    for (const value of ["raw provider output", 'ZEROS_DEV_PROOF {"durationMs":1000,"heartbeatCount":32,"maxHeartbeatGapMs":1000}',
      'ZEROS_DEV_PROOF {"durationMs":1860000,"heartbeatCount":32,"maxHeartbeatGapMs":180000}',
      'ZEROS_DEV_PROOF {}\nZEROS_DEV_PROOF {}', `ZEROS_DEV_PROOF ${"x".repeat(600)}`])
      expect(() => parseTaskProof(value)).toThrowError(expect.objectContaining({ code: "detached_proof_incomplete" }));
  });
  it("executes the exact generated program with monotonic time injected and refuses a duplicate", () => {
    const runner = `import contextlib,io,json,pathlib,sys,tempfile,time
program=sys.stdin.read()
elapsed=[0.0]
time.monotonic=lambda: elapsed[0]
time.monotonic_ns=lambda: int(elapsed[0]*1e9)
time.sleep=lambda seconds: elapsed.__setitem__(0,elapsed[0]+seconds)
with tempfile.TemporaryDirectory(prefix='zd-task-proof-') as root:
 file=pathlib.Path(root)/'long.py'
 file.write_text(program)
 with contextlib.redirect_stdout(io.StringIO()):
  exec(compile(program,str(file),'exec'),{'__file__':str(file)})
 rows=[json.loads(line) for line in (file.parent/'long.jsonl').read_text().splitlines()]
 assert len(rows)==32 and [row['n'] for row in rows]==list(range(32))
 assert rows[-1]['ms']-rows[0]['ms']==1860000
 try:
  exec(compile(program,str(file),'exec'),{'__file__':str(file)})
 except FileExistsError:
  pass
 else:
  raise AssertionError('duplicate task execution accepted')
print('confirmed')
`;
    expect(execFileSync("python3", ["-c", runner], { input: taskProgram(), encoding: "utf8", timeout: 5000 }).trim()).toBe("confirmed");
  });
});
