import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export const nativeQuestionInput = { questions: [{ question: "Which color?", header: "Color", multiSelect: false,
  options: [{ label: "Red", description: "First" }, { label: "Blue", description: "Second" }] }] };
type Tool = { name: string; input: Record<string, unknown> };
type ToolResult = { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };
type ApiRequest = { model: string; stream?: boolean; tools?: Array<{ name: string }>;
  messages: Array<{ content: string | Array<{ type: string }> }> };

/** Only the HTTP model reply is scripted; the pinned SDK and native tool loop run unchanged. */
export async function claudeNativeApi(steps: (directory: string) => Tool[]) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-claude-native-api-"));
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const executable = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === "win32" ? "claude.exe" : "claude"}`);
  const tools = steps(directory), requests: ApiRequest[] = [], results = new Map<string, ToolResult>();
  const children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  let closing = false, closeTask: Promise<void> | undefined;
  function spawnClaudeCodeProcess(options: SpawnOptions) {
    if (closing) throw new Error("Native fixture is closing");
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: "pipe" });
    child.stderr.resume();
    child.once("error", () => {});
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    children.set(child, closed);
    void closed.then(() => children.delete(child));
    return child;
  }
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/v1/messages")) { response.writeHead(404); response.end("{}"); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as ApiRequest;
    for (const message of body.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) if (block.type === "tool_result") results.set((block as ToolResult).tool_use_id, block as ToolResult);
    }
    const step = tools[requests.length]; requests.push(body);
    const block = step ? { type: "tool_use", id: `toolu_fixture_${requests.length}`, name: step.name, input: step.input }
      : { type: "text", text: "Offline fixture complete." };
    const message = { id: `msg_fixture_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [block],
      stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: step ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: step ? { type: "input_json_delta", partial_json: JSON.stringify(step.input) } : { type: "text_delta", text: "Offline fixture complete." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return { directory, executable, requests, results, spawnClaudeCodeProcess,
    env: { PATH: `${dirname(executable)}:${process.env.PATH}`, HOME: directory, ANTHROPIC_API_KEY: "offline-native-fixture-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CONFIG_DIR: join(directory, ".claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" },
    close() {
      closing = true;
      return closeTask ??= (async () => {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        // SDK close() returns before the native child's final filesystem writes.
        const grace = setTimeout(() => {
          for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 5_000);
        grace.unref();
        try { await Promise.all(children.values()); }
        finally { clearTimeout(grace); }
        await rm(directory, { recursive: true, force: true });
      })();
    },
  };
}
