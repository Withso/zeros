import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { JsonRpcResponseSuppressedError, JsonRpcStdioClient } from "../jsonrpc";

function fakeChild() {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(events, { stdin, stdout });
  return { child: child as never, stdin, stdout };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("JsonRpcStdioClient inbound request context", () => {
  it("passes the native request id and method to a request handler", async () => {
    const { child, stdin, stdout } = fakeChild();
    const client = new JsonRpcStdioClient(child);
    const handler = vi.fn(() => ({ ok: true }));
    client.onRequest("example/read", handler);

    stdout.write(
      `${JSON.stringify({ id: "native-7", method: "example/read", params: { value: 1 } })}\n`,
    );
    await nextTurn();

    expect(handler).toHaveBeenCalledWith(
      { value: 1 },
      { id: "native-7", method: "example/read" },
    );
    expect(stdin.read()?.toString()).toContain(
      '"id":"native-7","result":{"ok":true}',
    );
    client.close();
  });

  it("writes no late response when the peer already resolved the request", async () => {
    const { child, stdin, stdout } = fakeChild();
    const client = new JsonRpcStdioClient(child);
    client.onRequest("example/wait", async () => {
      throw new JsonRpcResponseSuppressedError();
    });

    stdout.write(
      `${JSON.stringify({ id: 9, method: "example/wait", params: {} })}\n`,
    );
    await nextTurn();

    expect(stdin.read()).toBeNull();
    client.close();
  });
});
