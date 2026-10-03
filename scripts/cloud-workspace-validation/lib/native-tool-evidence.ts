import type { CoreChallengeFiles } from "./core-tool-evidence";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const workspacePath = (value: unknown, file: string) =>
  value === file || value === `./${file}` || value === `/srv/zeros/workspace/${file}`;
const operands = (file: string) => [file, `./${file}`, `/srv/zeros/workspace/${file}`]
  .flatMap(value => [value, `'${value}'`, `"${value}"`]);

export function nativeChallengeCommand(value: unknown, files: CoreChallengeFiles): "read" | "exec" | null {
  if (typeof value !== "string") return null;
  // Codex's canonical command retains its native shell launcher. Match only
  // exact literal wrappers of the same canary command; never evaluate or
  // loosely strip quoting, operators, substitutions or additional argv.
  const matches = (command: string) => {
    if (value.trim() === command) return true;
    const quoted = [`'${command.replaceAll("'", `'"'"'`)}'`, `'${command.replaceAll("'", "'\\''")}'`,
      `"${command.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`];
    return ["/bin/bash", "/usr/bin/bash", "bash", "/bin/sh", "sh"].some(shell =>
      ["-lc", "-c"].some(flag => quoted.some(argument => value.trim() === `${shell} ${flag} ${argument}`)));
  };
  for (const source of operands(files.challenge)) {
    if (matches(`cat ${source}`)) return "read";
    for (const target of operands(files.executed))
      if (matches(`cat ${source} > ${target}`)) return "exec";
  }
  return null;
}

/** Consumes canonical tool updates at the caller's observation boundary. An MCP row or model
 * claim cannot qualify native execution; callers also verify effects on disk
 * independently before accepting the resulting evidence. */
export class NativeToolEvidence {
  private readonly records = new Map<string, Record<string, unknown>>();
  private events = 0;
  observe(value: unknown): void {
    const update = record(value);
    if (!["tool_call", "tool_call_update"].includes(String(update.sessionUpdate))) return;
    if (++this.events > 2048) throw new Error("Native tool evidence exceeded its bound");
    if (typeof update.toolCallId !== "string" || !update.toolCallId || update.toolCallId.length > 512) return;
    const previous = this.records.get(update.toolCallId) ?? {};
    for (const key of ["nativeToolCallId", "title", "kind", "rawInput", "status"])
      if (update[key] !== undefined && update[key] !== null) previous[key] = update[key];
    this.records.set(update.toolCallId, previous);
  }
  assertNoTools(): void {
    if (this.events) throw new Error("Native continuation used tools instead of conversation history");
  }
  assertMultiAgent(model: string): void {
    for (const tool of this.records.values()) {
      const input = record(tool.rawInput);
      if (tool.status === "completed" && tool.kind === "subagent" &&
          typeof tool.nativeToolCallId === "string" && tool.nativeToolCallId &&
          input.tool === "spawnAgent" && input.model === model) return;
    }
    throw new Error("Qualification lacks a completed native child using the selected model");
  }
  assertMcp(server: string, name: string): void {
    for (const tool of this.records.values()) {
      if (tool.status !== "completed" || typeof tool.nativeToolCallId !== "string" || !tool.nativeToolCallId) continue;
      const input = record(tool.rawInput);
      if ((input.server === server && input.tool === name) || (input.providerIdentifier === server && input.toolName === name) ||
          tool.title === `mcp__${server}__${name}` || tool.title === `${server}.${name}`) return;
    }
    throw new Error("Qualification lacks a successful native MCP tool call");
  }
  /** The exact owned canary, using assertMcp's unchanged row predicate. These
   * counts describe the qualification accumulator, not tool discovery or a
   * provider response. The summary contains no row identity, title, input or output. */
  canaryMcpSummary() {
    const matched = { rows: 0, completed: 0, failed: 0, pending: 0, unknownStatus: 0, nativeId: 0, missingNativeId: 0, successful: 0 };
    for (const tool of this.records.values()) {
      const input = record(tool.rawInput);
      if (!((input.server === "zeros-qualification" && input.tool === "probe") ||
          (input.providerIdentifier === "zeros-qualification" && input.toolName === "probe") ||
          tool.title === "mcp__zeros-qualification__probe" || tool.title === "zeros-qualification.probe")) continue;
      matched.rows++;
      switch (tool.status) {
        case "completed": matched.completed++; break;
        case "failed": matched.failed++; break;
        case "pending": case "in_progress": matched.pending++; break;
        default: matched.unknownStatus++;
      }
      const nativeId = typeof tool.nativeToolCallId === "string" && !!tool.nativeToolCallId;
      if (nativeId) matched.nativeId++; else matched.missingNativeId++;
      if (tool.status === "completed" && nativeId) matched.successful++;
    }
    return { version: 1 as const, events: Math.min(this.events, 2048), overflowed: this.events > 2048, uniqueRows: this.records.size, matched };
  }
  assertEffects(_provider: string, files: CoreChallengeFiles, _marker: string): void {
    const evidence = this.summary(files);
    if (!evidence.read || !evidence.write || !evidence.exec)
      throw new Error("Qualification lacks successful native read, edit or shell evidence");
  }
  /** Fixed booleans/counts only. Failed qualification can be diagnosed without
   * retaining provider output, commands, filenames, prompts or credentials. */
  summary(files: CoreChallengeFiles) {
    const observed = new Set<string>();
    let nativeReads = 0, nativeEdits = 0, nativeCommands = 0;
    for (const tool of this.records.values()) {
      if (tool.status !== "completed" || typeof tool.nativeToolCallId !== "string" || !tool.nativeToolCallId ||
          !["read", "edit", "execute"].includes(String(tool.kind))) continue;
      const input = record(tool.rawInput);
      if (input.server !== undefined || input.providerIdentifier !== undefined || input.tool === "zeros_workspace" ||
          String(tool.title).startsWith("mcp__")) continue;
      if (tool.kind === "read") nativeReads++;
      if (tool.kind === "edit") nativeEdits++;
      if (tool.kind === "execute") nativeCommands++;
      if (tool.kind === "read" && (workspacePath(input.file_path, files.challenge) || workspacePath(input.path, files.challenge))) observed.add("read");
      if (tool.kind === "edit" && (workspacePath(input.file_path, files.edited) || workspacePath(input.path, files.edited) ||
          (Array.isArray(input.changes) && input.changes.some(change => workspacePath(record(change).path, files.edited))))) observed.add("write");
      if (tool.kind === "execute" || tool.kind === "read") {
        const command = nativeChallengeCommand(input.command, files);
        if (command) observed.add(command);
      }
    }
    return { read: observed.has("read"), write: observed.has("write"), exec: observed.has("exec"), nativeReads, nativeEdits, nativeCommands };
  }
}
