/** Evidence comes only from correlated native tool records, never assistant text.
 * This observes the supported workspace callback, not general native-tool parity. */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type ToolRecord = { title?: unknown; rawInput?: unknown; rawOutput?: unknown; status?: unknown };
export type CoreChallengeFiles = { challenge: string; edited: string; executed: string };

function workspaceRequest(provider: string, tool: ToolRecord): Record<string, unknown> | null {
  const input = record(tool.rawInput);
  if (provider === "claude" && tool.title === "mcp__zeros_workspace__workspace") return record(input?.request);
  if (provider === "cursor" && input?.providerIdentifier === "custom-user-tools" && input.toolName === "workspace")
    return record(record(input.args)?.request);
  if (provider === "codex" && input?.tool === "zeros_workspace" && input.namespace === null) return record(input.arguments);
  return null;
}

function callbackResult(provider: string, output: unknown): Record<string, unknown> | null {
  // Claude uses MCP content directly; Codex uses dynamic-tool inputText items.
  // Cursor converts its custom callback into the SDK's MCP success/value and
  // protobuf text envelopes. Do not recursively hunt arbitrary model text.
  let value = output;
  if (provider === "cursor") {
    const envelope = record(value);
    if (envelope?.status !== "success") return null;
    value = envelope.value;
  }
  const envelope = record(value);
  if (envelope?.isError === true) return null;
  const content = Array.isArray(value) ? value : envelope?.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const item = record(content[0]);
  const text = provider === "cursor" ? record(item?.text)?.text
    : item?.type === (provider === "codex" ? "inputText" : "text") ? item.text : undefined;
  if (typeof text !== "string" || text.length > 262144) return null;
  try { return record(JSON.parse(text)); } catch { return null; }
}

export class CoreToolEvidence {
  private readonly records = new Map<string, ToolRecord>();
  private events = 0;
  observe(value: unknown): void {
    const update = record(value);
    if (!update || !["tool_call", "tool_call_update"].includes(String(update.sessionUpdate))) return;
    if (++this.events > 1024) throw new Error("Core tool callback evidence exceeded its bound");
    if (typeof update.toolCallId !== "string" || !update.toolCallId || update.toolCallId.length > 512) return;
    const previous = this.records.get(update.toolCallId) ?? {};
    // Completion updates may omit input/title. Preserve them by native row ID.
    for (const key of ["title", "rawInput", "rawOutput", "status"] as const) {
      if (update[key] !== undefined && update[key] !== null) previous[key] = update[key];
    }
    this.records.set(update.toolCallId, previous);
  }
  assertNoTools(): void {
    if (this.events) throw new Error("Core resume used a tool instead of native-history recall");
  }
  assertEffects(provider: string, files: CoreChallengeFiles, marker: string): void {
    const observed = new Set<string>();
    for (const tool of this.records.values()) {
      if (tool.status !== "completed") continue;
      const input = workspaceRequest(provider, tool), result = callbackResult(provider, tool.rawOutput);
      if (!input || result?.ok !== true) continue;
      if (input.operation === "read" && input.path === files.challenge) observed.add("read");
      if (input.operation === "write" && input.path === files.edited && input.content === marker) observed.add("write");
      if (input.operation === "exec" && input.command === `cat '${files.challenge}' > '${files.executed}'`) {
        const data = record(result.data), exit = record(data?.exit);
        if (data?.state === "exited" && exit?.code === 0 && exit.signal === null && data.timedOut === false) observed.add("exec");
      }
    }
    if (!["read", "write", "exec"].every(operation => observed.has(operation)))
      throw new Error("Core qualification lacks successful read, write or exec workspace tool callback evidence");
  }
}
