import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMirror } from "../../apps/desktop/src/engine/pty/mirror";
import {
  InfrastructureNative, InfrastructureNativeIntentSchema, InfrastructureNativeTaskSchema,
  InfrastructureNativeProofSchema, infrastructureNativeProgram,
  type InfrastructureNativeIntent,
} from "../zeros-dev/infrastructure-native";
import type { RunHandle } from "../zeros-dev/receipts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const signal = () => new AbortController().signal;
const rowText = (row: unknown) => `ZEROS_DEV_NATIVE ${JSON.stringify(row)}\r\n`;

function fixture() {
  let now = Date.parse("2026-10-15T00:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const boot = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 3,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const binding = { ...boot, authorityEpoch: 2 };
  const scope = { organizationId: boot.organizationId, workspaceId: boot.workspaceId, root: "/workspace/repository", engineWorkspaceId: randomUUID() };
  const handle: RunHandle = { run: { version: 1, runId: randomUUID(), fixtureSha256: "a".repeat(64), deviceId: randomUUID(),
    createdAt: new Date(now).toISOString(), source: { revision: "b".repeat(40), dirty: false }, prompts: [], lifecycle: [], evidence: [], deletionConfirmed: false,
    create: { key: randomUUID(), body: {} as never, result: { id: scope.workspaceId, createdBy: randomUUID(), generation: 3, createdAt: new Date(now).toISOString() } } },
    save: vi.fn(async () => {}) };
  const listeners = new Map<string, Set<(value: any) => void>>(), identityListeners = new Set<(value: any) => void>();
  const emit = (type: string, value: object) => { for (const callback of listeners.get(type) ?? []) callback({ type, ...value }); };
  let intent: InfrastructureNativeIntent | undefined, finished = false, allocated = false;
  const steps: string[] = [];
  const rows = () => Array.from({ length: 32 }, (_, n) => ({ n, ms: n * 60_000, run: handle.run.runId, nonce: intent!.nonce }));
  const fileProof = () => ({ programSha256: intent!.programSha256, outputSha256: sha(rows().map(row => JSON.stringify(row) + "\n").join("")), rows: rows() });
  const client = {
    status: "connected", executionIdentity: { kind: "cloud", ...boot, authorityEpoch: 2, bootScope: { ...boot } },
    activatedCloudAgentBootBinding: binding,
    on: vi.fn((type: string, callback: (value: any) => void) => {
      const list = listeners.get(type) ?? new Set(); list.add(callback); listeners.set(type, list); return () => list.delete(callback);
    }),
    onExecutionIdentityChange: vi.fn((callback: (value: any) => void) => { identityListeners.add(callback); return () => identityListeners.delete(callback); }),
    request: vi.fn(async (request: any) => {
      steps.push(request.type); expect(intent).toBeDefined(); expect(request.type).toBe("PTY_CREATE");
      const reattached = allocated; allocated = true;
      const replay = reattached ? `\u001b[?25l${rows().map(rowText).join("")}ZEROS_DEV_NATIVE_DONE ${intent!.nonce}\r\n$ ` : "";
      return { type: "PTY_CREATED", requestId: randomUUID(), sessionId: request.sessionId, cwd: scope.root,
        pid: 123, cols: request.cols, rows: request.rows, reattached, replay,
        replayBytes: Buffer.byteLength(replay), replayTruncated: false };
    }),
    send: vi.fn((message: any) => {
      steps.push(message.type);
      if (message.type === "PTY_WRITE") emit("PTY_DATA", { sessionId: message.sessionId, data: rowText(rows()[0]) });
      if (message.type === "PTY_KILL") emit("PTY_EXIT", { sessionId: message.sessionId, exitCode: 0, signal: null });
    }),
  };
  const runtime = { client, scope, terminal: vi.fn(async (_handle: RunHandle, input: { id?: string; script: string }) => {
    expect(intent).toBeDefined(); expect(Buffer.byteLength(input.script)).toBeLessThanOrEqual(2048);
    steps.push(finished ? "file-proof" : "install");
    return { exitCode: 0, truncated: false, output: finished ? `ZEROS_DEV_NATIVE_FILE ${JSON.stringify(fileProof())}\n` : "" };
  }) };
  const persistIntent = vi.fn(async (value: InfrastructureNativeIntent) => {
    if (intent) throw new Error("duplicate intent");
    steps.push("persist"); intent = InfrastructureNativeIntentSchema.parse(value);
  });
  const make = () => new InfrastructureNative(runtime as never, handle, { persistIntent });
  return { make, client, runtime, handle, scope, binding, boot, steps, persistIntent, rows, fileProof, emit,
    intent: () => intent!, listeners: () => [...listeners.values()].reduce((sum, value) => sum + value.size, 0) + identityListeners.size,
    complete: () => { finished = true; now += 31 * 60_000; },
    advance: (ms: number) => { now += ms; },
    identity: (value: any) => { for (const callback of identityListeners) callback(value); },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("infrastructure native detached task", () => {
  it("persists exact intent before effects, detaches all observers and proves only native output", async () => {
    const f = fixture(), begin = f.make(), task = await begin.begin(signal());
    expect(f.steps).toEqual(["persist", "install", "PTY_CREATE", "PTY_WRITE"]);
    expect(f.client.request.mock.calls[0]![0]).toMatchObject({ sessionId: task.sessionId, cwd: f.scope.root });
    expect(f.client.request.mock.calls[0]![0]).not.toHaveProperty("ephemeral");
    expect(InfrastructureNativeTaskSchema.parse(JSON.parse(JSON.stringify(task)))).toEqual(task);
    expect(f.listeners()).toBe(0);
    expect(f.client.send.mock.calls.filter(([message]) => message.type === "PTY_KILL")).toHaveLength(0);
    f.complete();
    const fresh = f.make(), proof = await fresh.finish(task, signal());
    expect(InfrastructureNativeProofSchema.parse(proof)).toMatchObject({ kind: "native-terminal-task", rowCount: 32,
      taskDurationMs: 1_860_000, maxHeartbeatGapMs: 60_000, replayTruncated: false,
      scopeSha256: task.scopeSha256, programSha256: task.programSha256, outputSha256: f.fileProof().outputSha256 });
    expect(f.client.send.mock.calls.filter(([message]) => message.type === "PTY_WRITE")).toHaveLength(1);
    expect(f.listeners()).toBe(0);
    await fresh.cleanup(task, signal());
    expect(f.client.send.mock.calls.filter(([message]) => message.type === "PTY_KILL")).toHaveLength(1);
    expect(f.listeners()).toBe(0); expect(f.handle.run.prompts).toEqual([]);
  });

  it("never allocates if saving the intent fails, or starts twice after an uncertain create", async () => {
    const f = fixture(); f.persistIntent.mockRejectedValueOnce(new Error("save failed"));
    await expect(f.make().begin(signal())).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(f.runtime.terminal).not.toHaveBeenCalled(); expect(f.client.request).not.toHaveBeenCalled();
    f.client.request.mockRejectedValueOnce(new Error("lost create acknowledgement"));
    const helper = f.make();
    await expect(helper.begin(signal())).rejects.toMatchObject({ code: "command_uncertain" });
    expect(f.intent().sessionId).toBeDefined(); expect(f.client.send).not.toHaveBeenCalled();
    await expect(helper.begin(signal())).rejects.toMatchObject({ code: "operation_conflict" });
    await expect(f.make().begin(signal())).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(f.client.request).toHaveBeenCalledOnce(); expect(f.listeners()).toBe(0);
  });

  it("retains uncertain write identity and never kills the task before the caller's failure boundary", async () => {
    const f = fixture(), controller = new AbortController();
    f.client.send.mockImplementationOnce(() => { controller.abort(); });
    await expect(f.make().begin(controller.signal)).rejects.toMatchObject({ code: "deadline" });
    expect(f.intent()).toBeDefined(); expect(f.client.send).toHaveBeenCalledOnce(); expect(f.listeners()).toBe(0);
  });

  it.each(["local", "organization", "workspace", "generation", "engine", "boot", "writer", "funding", "root", "authority"] as const)(
    "refuses a changed %s on reconnect and cannot kill a successor terminal", async kind => {
      const f = fixture(), task = await f.make().begin(signal()); f.complete();
      if (kind === "local") f.client.executionIdentity.kind = "local";
      if (kind === "organization") f.scope.organizationId = randomUUID();
      if (kind === "workspace") f.scope.workspaceId = randomUUID();
      if (kind === "generation") f.binding.generation++;
      if (kind === "engine") f.binding.engineInstanceId = randomUUID();
      if (kind === "boot") f.binding.bootId = randomUUID();
      if (kind === "writer") f.binding.writerEpoch = randomUUID();
      if (kind === "funding") f.binding.fundingOwnerEpoch++;
      if (kind === "root") f.scope.root = "/workspace/another";
      if (kind === "authority") f.binding.authorityEpoch++;
      const helper = f.make();
      await expect(helper.finish(task, signal())).rejects.toMatchObject({ code: "runtime_changed" });
      await expect(helper.cleanup(task, signal())).rejects.toMatchObject({ code: "runtime_changed" });
      expect(f.client.request).toHaveBeenCalledOnce(); expect(f.client.send).toHaveBeenCalledOnce();
    });

  it("latches an A to B to A scope change during a pending allocation", async () => {
    const f = fixture(), request = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementationOnce(async value => {
      f.identity({ ...f.client.executionIdentity, organizationId: randomUUID() });
      f.identity(f.client.executionIdentity); return request(value);
    });
    await expect(f.make().begin(signal())).rejects.toMatchObject({ code: "runtime_changed" });
    expect(f.client.send).not.toHaveBeenCalled(); expect(f.listeners()).toBe(0);
  });

  it.each(["denied", "new-terminal", "cwd", "truncation", "empty", "byte-count", "missing-first", "duplicate", "nonce", "duration", "gap", "pty-exit", "file-hash", "source-hash"] as const)(
    "refuses %s without restarting or rewriting the task", async kind => {
      const f = fixture(), task = await f.make().begin(signal()); f.complete();
      const request = f.client.request.getMockImplementation()!;
      f.client.request.mockImplementationOnce(async value => {
        if (kind === "denied") throw new Error("synthetic-private-provider-rejection");
        const reply = await request(value);
        if (kind === "new-terminal") reply.reattached = false;
        if (kind === "cwd") reply.cwd = "/elsewhere";
        if (kind === "truncation") reply.replayTruncated = true;
        if (kind === "empty") reply.replay = "";
        if (kind === "missing-first") reply.replay = reply.replay.replace(rowText(f.rows()[0]), "");
        if (kind === "duplicate") reply.replay += "\r\n" + rowText(f.rows()[0]);
        if (kind === "nonce") reply.replay = reply.replay.replace(f.intent().nonce, randomUUID());
        if (kind === "duration") reply.replay = f.rows().map(row => rowText({ ...row, ms: row.n * 58_000 })).join("") + `ZEROS_DEV_NATIVE_DONE ${task.nonce}\r\n`;
        if (kind === "gap") reply.replay = reply.replay.replace('"ms":60000', '"ms":100000');
        if (kind === "pty-exit") f.emit("PTY_EXIT", { sessionId: task.sessionId, exitCode: 0, signal: null });
        reply.replayBytes = Buffer.byteLength(reply.replay) + (kind === "byte-count" ? 1 : 0);
        return reply;
      });
      if (kind === "file-hash" || kind === "source-hash") f.runtime.terminal.mockResolvedValueOnce({ exitCode: 0, truncated: false,
        output: `ZEROS_DEV_NATIVE_FILE ${JSON.stringify({ ...f.fileProof(), [kind === "file-hash" ? "outputSha256" : "programSha256"]: "f".repeat(64) })}\n` });
      const predicate = { denied: "pty_create_unavailable", "new-terminal": "pty_not_reattached", cwd: "pty_cwd",
        truncation: "replay_truncated", empty: "replay_missing", "byte-count": "replay_bytes", "missing-first": "row_sequence",
        duplicate: "row_sequence", nonce: "row_identity", duration: "task_duration", gap: "heartbeat_gap", "pty-exit": "pty_exit",
        "file-hash": "output_hash", "source-hash": "program_hash" }[kind];
      await expect(f.make().finish(task, signal())).rejects.toMatchObject({ code: "detached_proof_incomplete", nativeProof: { predicate } });
      expect(f.client.send.mock.calls.filter(([message]) => message.type === "PTY_WRITE")).toHaveLength(1);
      expect(f.listeners()).toBe(0);
    });

  it("keeps the first closed observer failure when another event arrives before reattach completes", async () => {
    const f = fixture(), task = await f.make().begin(signal()); f.complete();
    const request = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementationOnce(async value => {
      f.emit("PTY_EXIT", { sessionId: task.sessionId, exitCode: 0, signal: null });
      f.emit("PTY_DATA", { sessionId: task.sessionId, data: "x".repeat(65_537) });
      return request(value);
    });
    await expect(f.make().finish(task, signal())).rejects.toMatchObject({ code: "detached_proof_incomplete", nativeProof: { predicate: "pty_exit" } });
    expect(f.runtime.terminal).toHaveBeenCalledOnce();
    expect(f.listeners()).toBe(0);
  });

  it.each(["denied", "cwd", "replay-limit"] as const)(
    "retains an observed PTY_EXIT before a later %s reply failure", async kind => {
      const f = fixture(), task = await f.make().begin(signal()); f.complete();
      const request = f.client.request.getMockImplementation()!;
      f.client.request.mockImplementationOnce(async value => {
        f.emit("PTY_EXIT", { sessionId: task.sessionId, exitCode: 0, signal: null });
        if (kind === "denied") throw new Error("private later refusal");
        const reply = await request(value);
        if (kind === "cwd") reply.cwd = "/later-wrong-root";
        if (kind === "replay-limit") { reply.replay = "x".repeat(65_537); reply.replayBytes = 65_537; }
        return reply;
      });
      await expect(f.make().finish(task, signal())).rejects.toMatchObject({ code: "detached_proof_incomplete", nativeProof: { predicate: "pty_exit" } });
      expect(f.runtime.terminal).toHaveBeenCalledTimes(1);
      expect(f.client.send.mock.calls.filter(([message]) => message.type === "PTY_WRITE")).toHaveLength(1);
      expect(f.listeners()).toBe(0);
    });

  it("retains an earlier PTY_EXIT when the later file result also fails", async () => {
    const f = fixture(), task = await f.make().begin(signal()); f.complete();
    f.runtime.terminal.mockImplementationOnce(async () => {
      f.emit("PTY_EXIT", { sessionId: task.sessionId, exitCode: 0, signal: null });
      return { exitCode: 1, truncated: true, output: "private later failure" };
    });
    await expect(f.make().finish(task, signal())).rejects.toMatchObject({ code: "detached_proof_incomplete", nativeProof: { predicate: "pty_exit" } });
    expect(f.listeners()).toBe(0);
  });

  it.each(["runtime_changed", "deadline"] as const)("keeps %s ahead of a latched native observation", async code => {
    const f = fixture(), task = await f.make().begin(signal()), controller = new AbortController(); f.complete();
    f.client.request.mockImplementationOnce(async () => {
      f.emit("PTY_EXIT", { sessionId: task.sessionId, exitCode: 0, signal: null });
      if (code === "runtime_changed") f.identity({ ...f.client.executionIdentity, authorityEpoch: 3 });
      else controller.abort();
      throw new Error("private later refusal");
    });
    await expect(f.make().finish(task, controller.signal)).rejects.toMatchObject({ code });
    expect(f.runtime.terminal).toHaveBeenCalledTimes(1); expect(f.listeners()).toBe(0);
  });

  it("does not accept a complete-looking remote proof before the original elapsed window or after its deadline", async () => {
    const f = fixture(), task = await f.make().begin(signal());
    await expect(f.make().finish(task, signal())).rejects.toMatchObject({ code: "detached_proof_incomplete" });
    f.advance(41 * 60_000);
    await expect(f.make().finish(task, signal())).rejects.toMatchObject({ code: "deadline" });
  });

  it("reads the real terminal mirror's serialized grid rather than inventing an event cursor", async () => {
    const f = fixture(), task = await f.make().begin(signal()); f.complete();
    const mirror = new TerminalMirror(240, 80), request = f.client.request.getMockImplementation()!;
    try {
      mirror.write("$ python3 task.py\r\n" + f.rows().map(rowText).join("") + `ZEROS_DEV_NATIVE_DONE ${task.nonce}\r\n$ `);
      const replay = await mirror.snapshot();
      f.client.request.mockImplementationOnce(async value => ({ ...await request(value), replay: replay.data, replayBytes: replay.bytes, replayTruncated: replay.truncated }));
      await expect(f.make().finish(task, signal())).resolves.toMatchObject({ rowCount: 32, replayBytes: replay.bytes });
    } finally { mirror.dispose(); }
  });

  it("joins the replay and live bytes that arrive before the reattach request resolves", async () => {
    const f = fixture(), task = await f.make().begin(signal()); f.complete();
    const request = f.client.request.getMockImplementation()!;
    f.client.request.mockImplementationOnce(async value => {
      const reply = await request(value), replay = f.rows().slice(0, 31).map(rowText).join("");
      f.emit("PTY_DATA", { sessionId: task.sessionId, data: rowText(f.rows()[31]) + `ZEROS_DEV_NATIVE_DONE ${task.nonce}\r\n` });
      return { ...reply, replay, replayBytes: Buffer.byteLength(replay) };
    });
    await expect(f.make().finish(task, signal())).resolves.toMatchObject({ rowCount: 32 });
    expect(f.listeners()).toBe(0);
  });

  it("refuses output duplicated while the file proof is pending", async () => {
    const f = fixture(), task = await f.make().begin(signal()); f.complete();
    const terminal = f.runtime.terminal.getMockImplementation()!;
    f.runtime.terminal.mockImplementationOnce(async (...args) => {
      f.emit("PTY_DATA", { sessionId: task.sessionId, data: "\r\n" + rowText(f.rows()[0]) });
      return terminal(...args);
    });
    await expect(f.make().finish(task, signal())).rejects.toMatchObject({ code: "detached_proof_incomplete" });
    expect(f.listeners()).toBe(0);
  });

  it("keeps cleanup bounded and exact when no kill acknowledgement arrives", async () => {
    const f = fixture(), task = await f.make().begin(signal()), controller = new AbortController();
    f.client.send.mockImplementationOnce(() => { controller.abort(); });
    await expect(f.make().cleanup(task, controller.signal)).rejects.toMatchObject({ code: "deadline" });
    expect(f.client.send.mock.calls.filter(([message]) => message.type === "PTY_KILL")).toHaveLength(1);
    expect(f.listeners()).toBe(0);
  });

  it("does not invoke any product operation for Local or an organization-local runtime", async () => {
    const f = fixture(); f.client.executionIdentity.kind = "local";
    await expect(f.make().begin(signal())).rejects.toMatchObject({ code: "runtime_changed" });
    expect(f.persistIntent).not.toHaveBeenCalled(); expect(f.runtime.terminal).not.toHaveBeenCalled();
    expect(f.client.request).not.toHaveBeenCalled(); expect(f.client.send).not.toHaveBeenCalled();
  });

  it("requires bounded closed schemas and refuses edited task identity", async () => {
    const f = fixture(), task = await f.make().begin(signal()); f.complete();
    expect(InfrastructureNativeIntentSchema.safeParse({ ...f.intent(), accessToken: "not-a-token" }).success).toBe(false);
    expect(InfrastructureNativeTaskSchema.safeParse({ ...task, firstRow: { ...task.firstRow, n: 1 } }).success).toBe(false);
    await expect(f.make().finish({ ...task, sessionId: `zd-infra-${randomUUID()}` }, signal())).rejects.toMatchObject({ code: "receipt_invalid" });
  });

  it("executes the actual fixed program, fsyncs every sample, and refuses a second run", () => {
    const program = infrastructureNativeProgram({ runId: randomUUID(), nonce: randomUUID() });
    const runner = `import contextlib,io,json,os,pathlib,sys,tempfile,time
program=sys.stdin.read(); elapsed=[0.0]; syncs=[0]
time.monotonic=lambda: elapsed[0]
time.monotonic_ns=lambda: int(elapsed[0]*1e9)
time.sleep=lambda seconds: elapsed.__setitem__(0,elapsed[0]+seconds)
real_sync=os.fsync
def sync(fd):
 syncs[0]+=1; real_sync(fd)
os.fsync=sync
with tempfile.TemporaryDirectory(prefix='zd-native-proof-') as root:
 file=pathlib.Path(root)/'task.py'; file.write_text(program)
 out=io.StringIO()
 with contextlib.redirect_stdout(out): exec(compile(program,str(file),'exec'),{'__file__':str(file)})
 rows=[json.loads(line) for line in (file.parent/'rows.jsonl').read_text().splitlines()]
 assert len(rows)==32 and [row['n'] for row in rows]==list(range(32))
 assert rows[-1]['ms']-rows[0]['ms']==1860000 and syncs[0]>=32
 assert out.getvalue().count('ZEROS_DEV_NATIVE ')==32
 for row in rows: assert 'ZEROS_DEV_NATIVE '+json.dumps(row,separators=(',',':')) in out.getvalue()
 try: exec(compile(program,str(file),'exec'),{'__file__':str(file)})
 except FileExistsError: pass
 else: raise AssertionError('duplicate native task accepted')
print('confirmed')
`;
    expect(execFileSync("python3", ["-c", runner], { input: program, encoding: "utf8", timeout: 5000 }).trim()).toBe("confirmed");
  });

  it("executes the exact bounded installation and file check and refuses duplicate installs and aliased files", async () => {
    const f = fixture(), task = await f.make().begin(signal()), root = mkdtempSync(path.join(tmpdir(), "zd-native-install-"));
    f.complete(); await f.make().finish(task, signal());
    const setup = f.runtime.terminal.mock.calls[0]![1].script, verify = f.runtime.terminal.mock.calls[1]![1].script;
    try {
      execFileSync("bash", ["-c", setup], { cwd: root, stdio: "pipe", timeout: 5000 });
      expect(() => execFileSync("bash", ["-c", setup], { cwd: root, stdio: "pipe", timeout: 5000 })).toThrow();
      const file = path.join(root, `.zeros-dev-infra-${task.runId}`, "task.py");
      expect(sha(readFileSync(file, "utf8"))).toBe(task.programSha256);
      execFileSync("python3", ["-c", `import pathlib,sys,time
elapsed=[0.0]
time.monotonic=lambda: elapsed[0]
time.monotonic_ns=lambda: int(elapsed[0]*1e9)
time.sleep=lambda seconds: elapsed.__setitem__(0,elapsed[0]+seconds)
p=pathlib.Path(sys.argv[1]);exec(compile(p.read_text(),str(p),'exec'),{'__file__':str(p)})
`, file], { stdio: "pipe", timeout: 5000 });
      const output = execFileSync("bash", ["-c", verify], { cwd: root, encoding: "utf8", timeout: 5000 });
      expect(JSON.parse(output.slice("ZEROS_DEV_NATIVE_FILE ".length))).toEqual(f.fileProof());
      unlinkSync(path.join(path.dirname(file), "rows.jsonl"));
      symlinkSync(file, path.join(path.dirname(file), "rows.jsonl"));
      expect(() => execFileSync("bash", ["-c", verify], { cwd: root, stdio: "pipe", timeout: 5000 })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
