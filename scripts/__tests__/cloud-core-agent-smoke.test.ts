import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_CORE_PROVIDER_RESTRICTIONS } from "../../packages/protocol/src/containment";
import { qualifyAgent } from "../cloud-workspace-validation/agent-smoke";
import { runPtyCommand } from "../cloud-workspace-validation/lib/pty-command";
import type { BridgeMessage } from "../cloud-workspace-validation/lib/bridge-client";

vi.mock("../cloud-workspace-validation/lib/pty-command", () => ({ runPtyCommand: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const selection = { agentId: "cursor", model: "grok-4.6", agentCredentialGrantId: randomUUID(), env: { ZEROS_THINKING_EFFORT: "xhigh" } };
type Options = {
  toolEvents?: boolean; effects?: boolean; designApi?: string; restriction?: string;
  noHistory?: boolean; genericTools?: boolean; omitOperation?: string; failedOperation?: string;
  foreignExecution?: boolean; completion?: boolean; resumeTools?: boolean;
  cleanupFails?: boolean; removalIgnored?: boolean;
};
function fixture(options: Options = {}) {
  const listeners = new Set<(message: BridgeMessage) => void>();
  const files = new Map<string, string>();
  let marker = "", challenge = "", turn = 0, revision = 0;
  const publish = (message: BridgeMessage) => { for (const listener of listeners) listener(message); };
  vi.mocked(runPtyCommand).mockImplementation(async () => {
    if (options.cleanupFails) throw new Error("cleanup failed");
    if (!options.removalIgnored) files.clear();
  });
  const client = {
    engineCapabilities: ["cloud.commands.v1"], sendMessage: vi.fn(), ptyCreate: vi.fn(), ptyWrite: vi.fn(), onPtyData: vi.fn(),
    onMessage(listener: (message: BridgeMessage) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    request: vi.fn(async (op: string, params: Record<string, unknown>) => {
      if (op === "file.write") { marker = String(params.content); challenge = String(params.path); files.set(challenge, marker); return {}; }
      if (op === "file.read") return files.has(String(params.path))
        ? { kind: "text", content: files.get(String(params.path)) }
        : { kind: "error", path: params.path, bytes: 0, error: "file no longer exists on disk" };
      if (op === "cloudCommands.createConversation") return {};
      const input = params.request as { kind: string; mutation: { action: { commandId: string; payload: unknown } } };
      if (input.kind === "read") return { state: "succeeded" };
      if (input.kind === "snapshot") return { revision };
      if (input.kind === "stop") return { paused: true, revision: ++revision };
      if (marker) expect(JSON.stringify(input.mutation.action.payload)).not.toContain(marker);
      const commandId = input.mutation.action.commandId, executionId = `core-execution-${++turn}`;
      queueMicrotask(() => {
        publish({ type: turn === 1 ? "AGENT_SESSION_CREATED" : "AGENT_SESSION_LOADED", agentId: "cursor", requestId: commandId,
          session: { executionId, boundary: { version: 1, actor: "agent-code", state: "ready", backend: "cloud-worker",
            designProtection: { required: true, enforced: true, protectedDirectoryCount: 1 }, parity: { level: "restricted", restrictions: [...CLOUD_CORE_PROVIDER_RESTRICTIONS.cursor, ...(options.restriction ? [options.restriction] : [])] },
            cloudExecution: { version: 1, profile: "zeros-cloud-core-v1", runtimeProfile: "zeros-cloud-worker-v3", provider: "cursor", designApi: options.designApi ?? "admitted" } } } });
        const emit = (update: Record<string, unknown>) => publish({ type: "AGENT_SESSION_UPDATE", agentId: "cursor", executionId: options.foreignExecution ? "stale-execution" : executionId, notification: { update } });
        if (turn === 1) {
          const edited = challenge.replace(/\.challenge$/, ".edited"), executed = challenge.replace(/\.challenge$/, ".executed");
          if (options.effects !== false) { files.set(edited, marker); files.set(executed, marker); }
          if (options.toolEvents !== false) {
            if (options.genericTools) emit({ sessionUpdate: "tool_call", toolCallId: "todo", title: "TodoWrite", status: "completed" });
            else for (const request of [
              { operation: "read", path: challenge },
              { operation: "write", path: edited, content: marker, expectedSha256: null },
              { operation: "exec", command: `cat '${challenge}' > '${executed}'` },
            ]) {
              if (options.omitOperation === request.operation) continue;
              emit({ sessionUpdate: "tool_call", toolCallId: request.operation, title: "mcp", status: "in_progress", rawInput: { providerIdentifier: "custom-user-tools", toolName: "workspace", args: { request } } });
              if (options.completion !== false) emit({ sessionUpdate: "tool_call_update", toolCallId: request.operation, status: options.failedOperation === request.operation ? "failed" : "completed",
                rawOutput: { status: "success", value: { content: [{ text: { text: JSON.stringify({ ok: true, data: { state: "exited", exit: { code: 0, signal: null }, timedOut: false } }) } }], isError: false } } });
            }
          }
        } else if (options.resumeTools) emit({ sessionUpdate: "tool_call", toolCallId: "resume-search", title: "workspace", rawInput: { request: { operation: "search", path: ".", pattern: "ZEROS_PING" } }, status: "completed" });
        publish({ type: "AGENT_SESSION_UPDATE", agentId: "cursor", executionId, notification: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn > 1 && options.noHistory ? [...files.values()][0] ?? "I have no previous marker" : marker } } } });
        publish({ type: "AGENT_PROMPT_COMPLETE", requestId: commandId, response: { effectiveModel: "grok-4.6" } });
      }); return { revision: ++revision };
    }),
  };
  return { client, listeners, files, turns: () => turn };
}
describe("explicit core agent qualification", () => {
  it("requires successful read/write/exec effects and removes every challenge before cold resume", async () => {
    const { client, listeners, files } = fixture();
    await qualifyAgent(client, selection, "workspace", 1000, "zeros-cloud-core-v1");
    expect(client.request.mock.calls.filter(([op]) => op === "file.read")).toHaveLength(5);
    expect(runPtyCommand).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(0); expect(files.size).toBe(0);
  });
  it.each([
    { options: { toolEvents: false }, error: /tool callback/ },
    { options: { genericTools: true }, error: /tool callback/ },
    { options: { omitOperation: "read" }, error: /tool callback/ },
    { options: { omitOperation: "write" }, error: /tool callback/ },
    { options: { omitOperation: "exec" }, error: /tool callback/ },
    { options: { failedOperation: "exec" }, error: /tool callback/ },
    { options: { completion: false }, error: /tool callback/ },
    { options: { foreignExecution: true }, error: /tool callback/ },
    { options: { effects: false }, error: /effect did not match/ },
    { options: { designApi: "unavailable" }, error: /core/ },
    { options: { restriction: "container-workflows-unavailable" }, error: /core/ },
    { options: { noHistory: true }, error: /unique marker/ },
    { options: { resumeTools: true }, error: /resume.*tool/i },
  ])("rejects missing evidence and retires the execution: $options", async ({ options, error }) => {
    const { client, listeners } = fixture(options);
    await expect(qualifyAgent(client, selection, "workspace", 1000, "zeros-cloud-core-v1")).rejects.toThrow(error);
    expect(runPtyCommand).toHaveBeenCalled(); expect(listeners.size).toBe(0);
  });
  it.each([{ cleanupFails: true }, { removalIgnored: true }])("does not start a second paid turn unless removal is verified: %j", async options => {
    const { client, turns } = fixture(options);
    await expect(qualifyAgent(client, selection, "workspace", 1000, "zeros-cloud-core-v1")).rejects.toThrow();
    expect(turns()).toBe(1);
  });
  it("does not silently fall back from full-native qualification to the core contract", async () => {
    const { client } = fixture();
    await expect(qualifyAgent(client, selection, "workspace", 1000)).rejects.toThrow(/full/);
    expect(runPtyCommand).not.toHaveBeenCalled();
  });
  it("refuses core qualification on legacy admission before starting paid work", async () => {
    const { client } = fixture(); client.engineCapabilities = [];
    await expect(qualifyAgent(client, selection, "workspace", 1000, "zeros-cloud-core-v1")).rejects.toThrow(/durable v3/);
    expect(client.request).not.toHaveBeenCalled(); expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
