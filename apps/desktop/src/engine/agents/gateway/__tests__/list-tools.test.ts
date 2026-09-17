import { afterEach, describe, expect, it, vi } from "vitest";
import { listAllBackendTools, TOOL_DISCOVERY_LIMITS as limits } from "../list-tools";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

afterEach(() => vi.useRealTimers());
const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });
const signal = () => new AbortController().signal;
const mock = () => vi.fn<Client["listTools"]>();

describe("bounded MCP discovery", () => {
  it("handles an empty opaque cursor and de-duplicates identical page overlap", async () => {
    const listTools = mock().mockResolvedValueOnce({ tools: [tool("one")], nextCursor: "" })
      .mockResolvedValueOnce({ tools: [tool("one"), tool("two")] });
    expect(await listAllBackendTools({ listTools }, signal())).toEqual([tool("one"), tool("two")]);
    expect(listTools.mock.calls[1]?.[0]).toEqual({ cursor: "" });
  });

  it("refuses conflicting duplicates", async () => {
    const listTools = mock().mockResolvedValueOnce({ tools: [tool("one")], nextCursor: "next" })
      .mockResolvedValueOnce({ tools: [{ ...tool("one"), description: "changed mid-page" }] });
    await expect(listAllBackendTools({ listTools }, signal())).rejects.toThrow(/conflicting/);
  });

  it.each(["pages", "tools", "bytes", "cursorBytes"] as const)("bounds %s", async (limit) => {
    let page = 0;
    const listTools = mock().mockImplementation(async () => {
      if (limit === "pages") return { tools: [], nextCursor: String(page++) };
      if (limit === "tools") return { tools: Array.from({ length: limits.tools + 1 }, (_, i) => tool(String(i))) };
      if (limit === "bytes") return { tools: [{ ...tool("large"), description: "x".repeat(limits.bytes) }] };
      return { tools: [], nextCursor: "x".repeat(limits.cursorBytes + 1) };
    });
    await expect(listAllBackendTools({ listTools }, signal())).rejects.toThrow(/limit/);
    expect(listTools).toHaveBeenCalledTimes(limit === "pages" ? limits.pages : 1);
  });

  it("does not fetch for an already retired generation", async () => {
    const abort = new AbortController(); abort.abort();
    const listTools = mock();
    await expect(listAllBackendTools({ listTools }, abort.signal)).rejects.toThrow();
    expect(listTools).not.toHaveBeenCalled();
  });

  it("bounds the entire traversal, rather than restarting the deadline per page", async () => {
    vi.useFakeTimers();
    let call = 0;
    const listTools = mock().mockImplementation(async (_params, options) => {
      if (call++ === 0) { await new Promise((resolve) => setTimeout(resolve, 10_000)); return { tools: [], nextCursor: "next" }; }
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
    });
    const pending = listAllBackendTools({ listTools }, signal());
    const outcome = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(limits.timeoutMs);
    await outcome;
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(listTools.mock.calls[1]?.[1]?.timeout).toBe(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a late page after cancellation and does not request another page", async () => {
    const abort = new AbortController();
    let finish!: (value: Awaited<ReturnType<Client["listTools"]>>) => void;
    const listTools = mock().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = listAllBackendTools({ listTools }, abort.signal);
    const outcome = expect(pending).rejects.toThrow();
    abort.abort();
    finish({ tools: [tool("late")], nextCursor: "next" });
    await outcome;
    expect(listTools).toHaveBeenCalledTimes(1);
  });
});
