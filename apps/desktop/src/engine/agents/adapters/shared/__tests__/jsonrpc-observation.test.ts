import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpcStdioClient } from "../jsonrpc";

const clients: JsonRpcStdioClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function process(order: string[] = []) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (line: string) => {
    order.push("stdin_write");
    const frame = JSON.parse(line);
    if (frame.id !== undefined) child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { admitted: true } })}\n`);
  });
  const client = new JsonRpcStdioClient(child as unknown as ChildProcess, { onOutbound: () => order.push("outbound"), defaultTimeoutMs: 20 });
  clients.push(client); return { child, client };
}

describe("trusted per-request native write observation", () => {
  it("observes actual write return after the legacy outbound hook and before awaited acknowledgement", async () => {
    const order: string[] = [], { client } = process(order);
    const result = await client.request("turn/start", {}, { onWritten: () => order.push("written") });
    order.push("acknowledged");
    expect(order).toEqual(["outbound", "stdin_write", "written", "acknowledged"]);
    expect(result).toEqual({ admitted: true });
  });

  it("contains observer failure without changing the native request result", async () => {
    const observed = vi.fn(() => { throw new Error("synthetic-observer-error"); }), { client } = process();
    await expect(client.request("turn/start", {}, { onWritten: observed })).resolves.toEqual({ admitted: true });
    expect(observed).toHaveBeenCalledOnce();
  });

  it("records buffered submission even when write returns false, without treating it as native receipt", async () => {
    const observed = vi.fn(), { child, client } = process(), write = child.stdin.write.bind(child.stdin);
    vi.spyOn(child.stdin, "write").mockImplementationOnce(chunk => { write(chunk); return false; });
    await expect(client.request("turn/start", {}, { onWritten: observed })).resolves.toEqual({ admitted: true });
    expect(observed).toHaveBeenCalledOnce();
  });

  it("keeps notifications and old requests unchanged without an observer", async () => {
    const order: string[] = [], { client } = process(order);
    client.notify("initialized", {});
    await expect(client.request("model/list", {})).resolves.toEqual({ admitted: true });
    expect(order).toEqual(["outbound", "stdin_write", "outbound", "stdin_write"]);
  });

  it("does not claim a write on a closed client", async () => {
    const observed = vi.fn(), { client } = process(); client.close();
    await expect(client.request("turn/start", {}, { onWritten: observed })).rejects.toThrow("client is closed");
    expect(observed).not.toHaveBeenCalled();
  });

  it("does not claim a write when stdin throws", async () => {
    const observed = vi.fn(), { child, client } = process();
    vi.spyOn(child.stdin, "write").mockImplementationOnce(() => { throw new Error("synthetic-write-refusal"); });
    await expect(client.request("turn/start", {}, { onWritten: observed })).rejects.toThrow("synthetic-write-refusal");
    expect(observed).not.toHaveBeenCalled();
  });

  it("does not claim a write if the native transport disappeared", async () => {
    const observed = vi.fn(), { child, client } = process(); Object.assign(child, { stdin: null });
    await expect(client.request("turn/start", {}, { onWritten: observed, timeoutMs: 5 })).rejects.toThrow("timed out");
    expect(observed).not.toHaveBeenCalled();
  });
});
