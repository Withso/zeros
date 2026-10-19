import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRunnerPipes } from "../cloud-runner-pipes";
import type { CloudRunnerIntent, CloudRunnerProof } from "../cloud-runner-contract";

const id = "11111111-1111-4111-8111-111111111111";
const executionId = "22222222-2222-4222-8222-222222222222";
const intent: CloudRunnerIntent = { version: 1, attemptId: id, scope: {
  version: 1, organizationId: id, workspaceId: id, generation: 1, engineInstanceId: id,
  bootId: id, writerEpoch: id, executionId, runtimeId: `r1-${"a".repeat(64)}`,
  owner: { pid: 20, startToken: "100" }, workload: {
    directory: "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload", dev: "1", ino: "2" },
} };
const proof: CloudRunnerProof = { version: 1, attemptId: id, bootId: id,
  unit: `zeros-agent-runner@${executionId}.service`, invocationId: "b".repeat(32), pid: 30, startToken: "200",
  cgroup: { directory: `${intent.scope.workload.directory}/runner/zeros-agent-runner@${executionId}.service`, dev: "1", ino: "3" } };
const resources: (() => void)[] = [];
afterEach(() => { resources.splice(0).forEach(close => close()); vi.useRealTimers(); });
function fixture() {
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, stderr: error, pid: 21 }) as unknown as ChildProcess;
  const interrupted = vi.fn(), assertCurrent = vi.fn();
  const pipes = new CloudRunnerPipes({ child, intent, timeoutMs: 100, interrupted, assertCurrent });
  child.stdin!.on("error", () => {}); child.stdout!.on("error", () => {});
  let sent = "", received = "";
  input.on("data", chunk => { sent += chunk.toString(); });
  child.stdout!.on("data", chunk => { received += chunk.toString(); });
  const frame = (type: string, value: unknown = proof) => output.write(`${JSON.stringify({ type, proof: value })}\n`);
  resources.push(() => { pipes.close(); input.destroy(); output.destroy(); error.destroy(); });
  return { pipes, child, input, output, interrupted, assertCurrent, frame, sent: () => sent, received: () => received };
}
const request = { command: "/bin/cat", args: [], cwd: "/workspace", env: { API_KEY: "synthetic-provider-material" } };

describe("private runner pipe handoff", () => {
  it("retains unread final provider bytes after natural EOF and positive retirement", async () => {
    const f = fixture(), starting = f.pipes.start(); f.frame("native"); f.frame("hello"); await starting;
    const channel = await f.pipes.connect(proof), sending = channel.send(request, new AbortController().signal);
    f.frame("ack"); await sending;
    f.child.stdout!.removeAllListeners("data"); f.child.stdout!.pause();
    const ended = new Promise<void>(resolve => f.output.once("end", resolve));
    f.output.end("last provider event\n"); await ended;
    channel.close();
    const chunks: Buffer[] = [];
    for await (const chunk of f.child.stdout!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("last provider event\n");
  });
  it("keeps provider writes behind independent native and runner proof and one material ACK", async () => {
    const f = fixture(), starting = f.pipes.start();
    f.child.stdin!.write("provider request\n");
    expect(f.sent()).not.toContain("provider request");
    expect(f.sent()).not.toContain(request.env.API_KEY);
    f.frame("hello"); f.frame("native"); await starting;
    const channel = await f.pipes.connect(proof), sending = channel.send(request, new AbortController().signal);
    expect(f.sent()).toContain(request.env.API_KEY);
    expect(f.sent()).not.toContain("provider request");
    f.frame("ack"); await sending;
    expect(f.sent()).toContain("provider request");
    f.output.write("provider output\n");
    expect(f.received()).toBe("provider output\n");
    expect(f.interrupted).not.toHaveBeenCalled();
    await expect(channel.send(request, new AbortController().signal)).rejects.toThrow();
    expect(f.sent().split(request.env.API_KEY)).toHaveLength(2);
  });
  it("rejects a runner hello with a reused PID birth before sending material", async () => {
    const f = fixture(), starting = f.pipes.start();
    f.frame("native"); await starting;
    const connection = f.pipes.connect(proof), rejected = expect(connection).rejects.toThrow();
    f.frame("hello", { ...proof, startToken: "201" }); await rejected;
    expect(f.sent()).not.toContain(request.env.API_KEY);
    expect(f.interrupted).toHaveBeenCalledOnce();
  });
  it("does not accept a fabricated ACK before the private frame", async () => {
    const f = fixture(), starting = f.pipes.start(), rejected = expect(starting).rejects.toThrow();
    f.frame("ack"); await rejected;
    expect(f.sent()).not.toContain(request.env.API_KEY);
    expect(f.interrupted).toHaveBeenCalledOnce();
  });
  it("closes a bounded startup write queue without feeding provider bytes early", async () => {
    const f = fixture(), starting = f.pipes.start(), rejected = expect(starting).rejects.toThrow();
    f.child.stdin!.write(Buffer.alloc(8 * 1024 * 1024 + 1)); await rejected;
    expect(f.sent()).not.toContain("\0");
    expect(f.interrupted).toHaveBeenCalledOnce();
  });
  it("cancellation during an unacknowledged handoff cannot reopen the input gate", async () => {
    const f = fixture(), starting = f.pipes.start(); f.frame("native"); f.frame("hello"); await starting;
    const channel = await f.pipes.connect(proof), abort = new AbortController();
    const sending = channel.send(request, abort.signal), rejected = expect(sending).rejects.toThrow();
    f.child.stdin!.write("late provider bytes"); abort.abort(); await rejected;
    f.frame("ack");
    expect(f.sent()).not.toContain("late provider bytes");
    expect(f.interrupted).toHaveBeenCalledOnce();
  });
  it("bounds an incomplete hello and never exposes it as provider stdout", async () => {
    const f = fixture(), starting = f.pipes.start(), rejected = expect(starting).rejects.toThrow();
    f.output.write("x".repeat(4097)); await rejected;
    expect(f.received()).toBe("");
    expect(f.interrupted).toHaveBeenCalledOnce();
  });
  it("times out a silent native submission and discards its late proof", async () => {
    vi.useFakeTimers();
    const f = fixture(), starting = f.pipes.start(), rejected = expect(starting).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(101); await rejected;
    f.frame("native"); f.frame("hello");
    await expect(f.pipes.connect(proof)).rejects.toThrow();
    expect(f.interrupted).toHaveBeenCalledOnce();
  });
  it("keeps output after the ACK byte-identical even when frames share a chunk", async () => {
    const f = fixture(), starting = f.pipes.start(); f.frame("native"); f.frame("hello"); await starting;
    const channel = await f.pipes.connect(proof), sending = channel.send(request, new AbortController().signal);
    f.output.write(`${JSON.stringify({ type: "ack", proof })}\n{"type":"native","provider":"opaque"}\n`);
    await sending;
    expect(f.received()).toBe('{"type":"native","provider":"opaque"}\n');
  });
  it("holds even an empty provider EOF until the material handoff is acknowledged", async () => {
    const f = fixture(), starting = f.pipes.start();
    void starting.catch(() => {});
    f.child.stdin!.end();
    expect(f.input.writableEnded).toBe(false);
    f.frame("native"); f.frame("hello"); await starting;
    const channel = await f.pipes.connect(proof), sending = channel.send(request, new AbortController().signal);
    expect(f.input.writableEnded).toBe(false);
    f.frame("ack"); await sending;
    expect(f.input.writableEnded).toBe(true);
    expect(f.sent()).toContain(request.env.API_KEY);
  });
  it("bounds a single end chunk just like queued writes", async () => {
    const f = fixture(), starting = f.pipes.start(), rejected = expect(starting).rejects.toThrow();
    f.child.stdin!.end(Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(f.interrupted).toHaveBeenCalledOnce();
    await rejected;
    expect(f.sent()).not.toContain("\0");
  });

  it("preserves a provider frame larger than the private material frame bound", async () => {
    const f = fixture(), starting = f.pipes.start();
    void starting.catch(() => {});
    const payload = "p".repeat(1024 * 1024);
    f.child.stdin!.write(payload);
    expect(f.interrupted).not.toHaveBeenCalled();
    f.frame("native"); f.frame("hello"); await starting;
    const channel = await f.pipes.connect(proof), sending = channel.send(request, new AbortController().signal);
    f.frame("ack"); await sending;
    expect(f.sent()).toContain(payload);
  });

  it("checks the authority deadline again before an ACK releases queued provider input", async () => {
    const f = fixture(), starting = f.pipes.start(); f.frame("native"); f.frame("hello"); await starting;
    const channel = await f.pipes.connect(proof), sending = channel.send(request, new AbortController().signal);
    const rejected = expect(sending).rejects.toThrow();
    f.child.stdin!.write("must-not-start-after-deadline");
    f.assertCurrent.mockImplementation(() => { throw new Error("authority expired"); });
    f.frame("ack");
    expect(f.sent()).not.toContain("must-not-start-after-deadline");
    await rejected;
  });

});
