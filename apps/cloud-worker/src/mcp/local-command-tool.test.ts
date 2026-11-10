import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalCommandInput, LocalCommandResult } from "@zeros/protocol/local-commands";
import { WorkspaceAgentTools } from "./agent-tools";
import { LocalCommandUnknownError } from "../local-commands/client";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(run?: (input: LocalCommandInput, signal: AbortSignal) => Promise<LocalCommandResult>) {
  const checkout = await mkdtemp(join(tmpdir(), "local-command-")); cleanups.push(() => rm(checkout, { recursive: true, force: true }));
  const localCommand = vi.fn(run ?? (async () => ({ outcome: "completed", code: 0, stdout: "hello\n", stderr: "", cwd: "/Users/alex", mac: "Alex's MacBook" }) as LocalCommandResult));
  const acknowledged = vi.fn(async () => {});
  const tools = new WorkspaceAgentTools({ assertCurrent: () => {}, terminalOutput: async () => undefined, diff: async () => ({ text: "", truncated: false }),
    localCommands: { run: async (input, signal) => ({ result: await localCommand(input, signal), acknowledge: acknowledged }), checkout } });
  return { tools, localCommand, checkout, acknowledged };
}
const call = (tools: WorkspaceAgentTools, input: unknown, signal = new AbortController().signal) =>
  tools.callTool("RunLocalCommand", input, signal) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

describe("RunLocalCommand", () => {
  it("is offered only with a local command transport", async () => {
    expect((await fixture()).tools.listTools().map(tool => tool.name)).toContain("RunLocalCommand");
    // The agent learns up front that a command is one-shot: & does not survive, a held stdout waits for the timeout.
    expect((await fixture()).tools.listTools().find(tool => tool.name === "RunLocalCommand")?.description).toMatch(/one-shot.*& does not survive.*until its timeout/);
    const without = new WorkspaceAgentTools({ assertCurrent: () => {}, terminalOutput: async () => undefined, diff: async () => ({ text: "", truncated: false }) });
    expect(without.listTools().map(tool => tool.name)).not.toContain("RunLocalCommand");
    await expect(without.callTool("RunLocalCommand", { command: "ls" }, new AbortController().signal)).rejects.toThrow();
  });

  it("runs a validated command and reports the Mac, directory and exit code with both streams", async () => {
    const f = await fixture();
    const result = await call(f.tools, { command: "echo hello", cwd: "~/src", description: "Say hello" });
    expect(f.localCommand).toHaveBeenCalledWith({ command: "echo hello", cwd: "~/src", description: "Say hello" }, expect.any(AbortSignal));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("outcome: completed\nmac: Alex's MacBook\ncwd: /Users/alex\nexit code: 0\n--- stdout ---\nhello\n");
    expect(f.acknowledged).toHaveBeenCalledOnce();
    for (const bad of [{}, { command: "" }, { command: "x", timeoutMs: 600_000 }, { command: "x", extra: true }]) {
      const refused = await call(f.tools, bad);
      expect(refused.isError).toBe(true); expect(refused.content[0].text).toContain("INVALID_INPUT");
    }
    expect(f.localCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps every outcome distinct, and never reports an approval timeout as a denial", async () => {
    const texts: Record<string, string> = {};
    for (const outcome of ["failed", "denied", "approval_timed_out", "command_timed_out", "mac_not_connected", "no_target", "disabled", "cancelled", "interrupted"] as const) {
      const f = await fixture(async () => ({ outcome, mac: "Studio", ...(outcome === "command_timed_out" ? { timedOut: true, stdout: "partial" } : {}),
        ...(outcome === "failed" ? { error: "cwd_not_found" as const } : {}) }));
      const result = await call(f.tools, { command: "sleep 999" });
      expect(result.isError, outcome).toBe(true);
      texts[outcome] = result.content[0].text;
      expect(texts[outcome].split("\n")[0]).toBe(`outcome: ${outcome}`);
    }
    expect(texts.approval_timed_out).not.toMatch(/declin|denied/i);
    expect(texts.approval_timed_out).toContain("did not run");
    expect(texts.denied).toContain("declined");
    expect(texts.command_timed_out).toContain("partial");
    expect(texts.failed).toContain("directory does not exist on Studio");
    expect(new Set(Object.values(texts)).size).toBe(9);
  });

  it("saves formatted output above 32 000 characters under the checkout's .context and returns the path", async () => {
    const big = "line\n".repeat(10_000);
    const f = await fixture(async () => ({ outcome: "completed", code: 0, stdout: big, stderr: "warn\n", stdoutTruncated: true, mac: "Studio" }));
    const result = await call(f.tools, { command: "cat big.log" });
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(2_000);
    const path = /saved to (\S+)/.exec(text)![1]!;
    expect(path.startsWith(join(f.checkout, ".context", "local-commands") + "/")).toBe(true);
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("--- stdout ---\n" + big);
    expect(saved).toContain("stdout truncated on the Mac");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("passes Stop to the transport, and reports an unknown outcome as a tool failure, never as a command outcome", async () => {
    let seen: AbortSignal | undefined;
    const f = await fixture((_input, signal) => { seen = signal; return new Promise(resolve => signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }), { once: true })); });
    const controller = new AbortController();
    const running = call(f.tools, { command: "sleep 999" }, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
    expect((await running).content[0].text.split("\n")[0]).toBe("outcome: cancelled");
    expect(seen!.aborted).toBe(true);
    const unknown = await fixture(async () => { throw new LocalCommandUnknownError(); });
    const result = await call(unknown.tools, { command: "make" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("LOCAL_COMMAND_UNKNOWN");
    expect(result.content[0].text).not.toMatch(/outcome: /);
    expect(unknown.acknowledged).not.toHaveBeenCalled();
  });
});
