import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface HostMessage {
  k: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: { message?: string };
}

describe("Cursor SDK host portable local store", () => {
  let child: ChildProcessWithoutNullStreams | null = null;

  afterEach(async () => {
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child?.kill("SIGKILL");
        resolve();
      }, 3_000);
      child?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child = null;
  });

  it("injects one JSONL store into create, list, and diagnostic reads", async () => {
    const host = fileURLToPath(new URL("../host/cursor-host.cjs", import.meta.url));
    const sdk = fileURLToPath(
      new URL("./fixtures/cursor-sdk-jsonl.cjs", import.meta.url),
    );
    child = spawn(process.execPath, [host], {
      env: { ...process.env, ZEROS_CURSOR_SDK_ENTRY: sdk },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const messages: HostMessage[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) messages.push(JSON.parse(line) as HostMessage);
        nl = buffer.indexOf("\n");
      }
    });

    const waitFor = async (predicate: (message: HostMessage) => boolean) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("timed out waiting for Cursor host response");
    };
    const send = (id: number, op: string, args: unknown) => {
      child!.stdin.write(`${JSON.stringify({ k: "req", id, op, args })}\n`);
    };

    await waitFor((message) => message.k === "ready");
    send(1, "agent.create", {
      apiKey: "fixture",
      local: { cwd: "/tmp/cursor-jsonl-workspace" },
    });
    expect(await waitFor((message) => message.id === 1)).toMatchObject({
      ok: true,
    });

    send(2, "agent.resume", {
      agentId: "fixture-agent",
      opts: { local: { cwd: "/tmp/cursor-jsonl-workspace" } },
    });
    expect(await waitFor((message) => message.id === 2)).toMatchObject({
      ok: true,
    });

    send(3, "agent.list", {
      opts: { runtime: "local", cwd: "/tmp/cursor-jsonl-workspace" },
    });
    expect(await waitFor((message) => message.id === 3)).toMatchObject({
      ok: true,
    });

    send(4, "store.open", { workspaceRef: "/tmp/cursor-jsonl-workspace" });
    const opened = await waitFor((message) => message.id === 4);
    expect(opened).toMatchObject({ ok: true });
    const storeId = (opened.result as { storeId?: string }).storeId;
    expect(storeId).toBeTruthy();

    send(5, "store.runGet", {
      storeId,
      agentId: "fixture-agent",
      runId: "fixture-run",
    });
    expect(await waitFor((message) => message.id === 5)).toMatchObject({
      ok: true,
      result: { error: "fixture-error" },
    });
  });
});
