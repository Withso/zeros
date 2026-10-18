import { describe, expect, it, vi } from "vitest";
import { CloudSdkCommandSender } from "../cloud-sdk-command-sender";

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
function command(index = 1, kind = "enqueue") {
  return JSON.stringify({ id: `request-${index}`, source: "browser", timestamp: 1_800_000_000_000, type: "WORKSPACE_REQUEST", op: "cloudCommands.request",
    params: { cloudLocalCommandsVersion: 1, bootId: id(1), writerEpoch: id(2), request: { kind: "mutate", mutation: {
      conversationId: "conversation-1", operationId: id(10 + index), expectedRevision: 0, action: { kind, commandId: id(10 + index),
        payload: { agentId: "claude", model: "claude-sonnet-4-6", modeRevision: 0, userMessageId: `turn-${index}`,
          prompt: [{ type: "text", text: "synthetic command" }] } } } } } });
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture() {
  let current = true;
  const prepare = vi.fn(async (_text: string) => "opaque native envelope"), send = vi.fn(), cancel = vi.fn();
  const sender = new CloudSdkCommandSender({ prepare, send, cancel, assertCurrent: () => { if (!current) throw new Error("retired"); } });
  return { sender, prepare, send, cancel, retire: () => { current = false; } };
}

describe("bounded SDK command send", () => {
  it("forwards the returned bytes once and preserves command order across signing", async () => {
    const f = fixture(), gate = deferred<string>(); f.prepare.mockReturnValueOnce(gate.promise);
    const first = f.sender.send(command()), second = f.sender.send(command(2)), editText = command(3, "edit"), edit = f.sender.send(editText);
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith(command()); expect(f.send).not.toHaveBeenCalled();
    gate.resolve("first opaque native envelope"); await Promise.all([first, second, edit]);
    expect(f.send.mock.calls.map(([text]) => text)).toEqual(["first opaque native envelope", "opaque native envelope", editText]);
    expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.cancel).not.toHaveBeenCalled();
  });

  it("keeps read, stop, edit, native operations and legacy prompts byte-identical with no proof request", async () => {
    const f = fixture(), base = JSON.parse(command());
    const texts = [command(1, "edit"),
      JSON.stringify({ ...base, params: { ...base.params, cloudLocalCommandsVersion: undefined } }),
      ...["read", "stop", "snapshot"].map(kind => JSON.stringify({ ...base, params: { ...base.params, request: { kind } } })),
      JSON.stringify({ ...base, params: { ...base.params, request: { ...base.params.request, mutation: { ...base.params.request.mutation,
        action: { ...base.params.request.mutation.action, payload: { ...base.params.request.mutation.action.payload, operation: { kind: "compact" } } } } } } }),
    ];
    for (const text of texts) await f.sender.send(text);
    expect(f.send.mock.calls.map(([text]) => text)).toEqual(texts); expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each(["cancel", "retire", "close"])("never sends a late envelope after %s", async reason => {
    const f = fixture(), gate = deferred<string>(), stop = new AbortController(); f.prepare.mockReturnValueOnce(gate.promise);
    const pending = f.sender.send(command(), stop.signal); const rejected = expect(pending).rejects.toThrow();
    if (reason === "cancel") stop.abort();
    if (reason === "retire") f.retire();
    if (reason === "close") f.sender.close();
    gate.resolve("late native envelope"); await rejected;
    expect(f.send).not.toHaveBeenCalled();
    if (reason !== "retire") expect(f.cancel).toHaveBeenCalledExactlyOnceWith("request-1");
  });

  it("drops a queued cancellation before native signing and removes its payload from the queue", async () => {
    const f = fixture(), gate = deferred<string>(), stop = new AbortController(); f.prepare.mockReturnValueOnce(gate.promise);
    const first = f.sender.send(command()), second = f.sender.send(command(2), stop.signal);
    const rejected = expect(second).rejects.toThrow(); stop.abort(); await rejected;
    gate.resolve("first envelope"); await first;
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledExactlyOnceWith("first envelope");
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it("rejects supplied proof bytes and never retries a failed proof as a legacy command", async () => {
    const f = fixture(), base = JSON.parse(command());
    await expect(f.sender.send(JSON.stringify({ ...base, params: { ...base.params, acceptedWorkProof: {} } }))).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
    f.prepare.mockRejectedValueOnce(new Error("proof refused"));
    await expect(f.sender.send(command())).rejects.toThrow("proof refused");
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });

  it("bounds pending commands while one signer is stalled", async () => {
    const f = fixture(), gate = deferred<string>(); f.prepare.mockReturnValueOnce(gate.promise);
    const pending = Array.from({ length: 16 }, (_, index) => f.sender.send(command(index + 1)));
    for (const promise of pending) void promise.catch(() => {});
    await expect(f.sender.send(command(17))).rejects.toThrow(/busy/i);
    expect(f.prepare).toHaveBeenCalledOnce();
    f.sender.close(); gate.resolve("late envelope");
    expect((await Promise.allSettled(pending)).every(result => result.status === "rejected")).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("bounds queued UTF-8 bytes independently of the command count", async () => {
    const f = fixture(), gate = deferred<string>(); f.prepare.mockReturnValueOnce(gate.promise);
    const large = (index: number) => { const frame = JSON.parse(command(index));
      frame.params.request.mutation.action.payload.prompt[0].text = "😀".repeat(45_000); return JSON.stringify(frame); };
    const pending = Array.from({ length: 5 }, (_, index) => f.sender.send(large(index + 1)));
    for (const promise of pending) void promise.catch(() => {});
    await expect(f.sender.send(large(6))).rejects.toThrow(/busy/i);
    f.sender.close(); gate.resolve("late envelope"); await Promise.allSettled(pending);
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });

  it("treats a missing rejection reason as a failed preparation, never as a completed send", async () => {
    const f = fixture(); f.prepare.mockRejectedValueOnce(undefined);
    await expect(f.sender.send(command())).rejects.toThrow(); expect(f.send).not.toHaveBeenCalled();
  });
});
