import type { ContentBlock, QuestionRequest, RequestPermissionRequest, ResourceLinkContent, SessionNotification, ToolCall, ToolCallUpdate } from "@zeros/protocol/agent-events";

/** Literal filtering is for provider-authored content. Routing identities and
 * protocol discriminants must never pass through a generic object scrubber. */
export class CloudCustomizationRedactor {
  private secrets: string[] = [];
  private pattern: RegExp | null = null;
  private readonly pending = new Map<string, string>();
  private readonly notifications = new Map<string, SessionNotification>();
  private readonly tools = new Map<string, ToolCallUpdate>();
  constructor(values: string[]) {
    this.addSecrets(values);
  }
  /** Add engine-minted product headers before the native provider starts. */
  addSecrets(values: string[]): void {
    this.secrets = [...new Set([...this.secrets, ...values.filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1),
      ...(value.startsWith("Bearer ") || value.startsWith("Basic ") ? [value.slice(value.indexOf(" ") + 1)] : [])])])].sort((a, b) => b.length - a.length);
    const pattern = this.secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    // Valid 64 KiB env literals can exceed V8's compiled-regexp limit.
    this.pattern = pattern.length && pattern.length <= 16384 ? new RegExp(pattern, "g") : null;
  }
  private text(value: string): string {
    if (this.pattern) return value.replace(this.pattern, "[redacted]");
    if (!this.secrets.length) return value;
    let result = "", offset = 0;
    while (offset < value.length) {
      let next = value.length, matched = "";
      // Preserve the regexp's earliest, longest match without rescanning the
      // replacement marker as if it were provider output.
      for (const secret of this.secrets) {
        const index = value.indexOf(secret, offset);
        if (index >= 0 && index < next) { next = index; matched = secret; }
      }
      if (!matched) return result + value.slice(offset);
      result += value.slice(offset, next) + "[redacted]";
      offset = next + matched.length;
    }
    return result;
  }
  private suffix(value: string): number {
    let keep = 0;
    for (const secret of this.secrets) for (let size = Math.min(secret.length - 1, value.length); size > keep; size--)
      if (value.endsWith(secret.slice(0, size))) { keep = size; break; }
    return keep;
  }
  /** A cumulative snapshot replaces previous content; do not concatenate its
   * withheld suffix with the next snapshot (which already includes it). */
  private snapshot(value: string, terminal = false): string {
    value = this.text(value);
    const keep = this.suffix(value);
    return keep ? value.slice(0, -keep) + (terminal ? "[redacted]" : "") : value;
  }
  /** Diagnostics can append stack frames after a truncated stderr/message.
   * Treat each line boundary as terminal, including multiline literal prefixes. */
  private terminal(value: string): string {
    const filtered = this.text(value), ranges: { start: number; end: number }[] = [];
    for (const match of filtered.matchAll(/\r?\n|$/g)) {
      const end = match.index, keep = this.suffix(filtered.slice(0, end));
      if (!keep) continue;
      const start = end - keep, previous = ranges.at(-1);
      if (previous && start <= previous.end) { previous.start = Math.min(previous.start, start); previous.end = end; }
      else ranges.push({ start, end });
    }
    let result = "", offset = 0;
    for (const range of ranges) { result += filtered.slice(offset, range.start) + "[redacted]"; offset = range.end; }
    return result + filtered.slice(offset);
  }
  value<T>(value: T, partial: boolean | "terminal" = false): T {
    if (typeof value === "string") return (partial === "terminal" ? this.terminal(value) : partial ? this.snapshot(value) : this.text(value)) as T;
    if (Array.isArray(value)) return value.map(entry => this.value(entry, partial)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.value(entry, partial)])) as T;
    return value;
  }
  private fields<T extends object>(value: T, names: readonly string[], partial: boolean | "terminal" = false): T {
    const result = { ...value } as Record<string, unknown>;
    for (const name of names) if (name in result) result[name] = this.value(result[name], partial);
    return result as T;
  }
  private content(content: ContentBlock, partial: boolean | "terminal" = false): ContentBlock {
    switch (content.type) {
      case "text": return this.fields(content, ["text"], partial);
      case "resource_link": return this.fields(content, ["uri", "name", "title", "description"], partial);
      case "resource": return { ...content, resource: this.fields(content.resource, ["uri", "text"], partial) };
      case "image": return this.fields(content, ["uri"], partial);
      case "audio": return content;
    }
  }
  private tool<T extends ToolCall | ToolCallUpdate>(tool: T, partial: boolean | "terminal"): T {
    return { ...this.fields(tool, ["title", "rawInput", "rawOutput"], partial),
      ...(tool.locations ? { locations: tool.locations.map(location => this.fields(location, ["path"], partial)) } : {}),
      ...("resourceLinks" in tool && tool.resourceLinks ? {resourceLinks:tool.resourceLinks.map((link: ResourceLinkContent) => this.fields(link,["uri","name","title","description"],partial))} : {}),
      ...(tool.content ? { content: tool.content.map(item => item.type === "content" ? { ...item, content: this.content(item.content, partial) }
        : item.type === "diff" ? this.fields(item, ["path", "oldText", "newText"], partial) : item) } : {}) };
  }
  notification(notification: SessionNotification): SessionNotification {
    const update = notification.update;
    if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text") {
      const key = JSON.stringify([notification.sessionId, update.sessionUpdate, update.messageId ?? null, update.parentToolId ?? null,
        "phase" in update ? update.phase ?? null : null]);
      if (update.textMode === "replace") this.finish(key);
      const text = this.stream(key, update.content.text);
      if (this.pending.has(key)) {
        const { textMode: _mode, ...tail } = update;
        this.notifications.set(key, { ...notification, update: { ...tail, content: { ...update.content, text: "" } } });
      } else this.notifications.delete(key);
      return { ...notification, update: { ...update, content: { ...update.content, text } } };
    }
    switch (update.sessionUpdate) {
      case "user_message_chunk": case "agent_message_chunk": case "agent_thought_chunk":
        return { ...notification, update: { ...update, content: this.content(update.content, true) } };
      case "tool_call": case "tool_call_update": {
        const key = JSON.stringify([notification.sessionId, update.toolCallId]);
        const terminal = update.status === "completed" || update.status === "failed";
        const tool = { ...this.tools.get(key), ...update };
        if (terminal) this.tools.delete(key);
        else { if (this.tools.size >= 256) this.tools.delete(this.tools.keys().next().value!); this.tools.set(key, tool); }
        return { ...notification, update: this.tool(tool, terminal ? "terminal" : true) };
      }
      case "error_notice": return { ...notification, update: this.fields(update, ["message"], "terminal") };
      case "session_info_update": return { ...notification, update: this.fields(update, ["title"], true) };
      case "mode_switch": return { ...notification, update: this.fields(update, ["reason"]) };
      case "goal_update": return { ...notification, update: { ...update, goal: update.goal ? this.fields(update.goal, ["objective"], true) : null } };
      case "available_commands_update": return { ...notification, update: { ...update, availableCommands: update.availableCommands.map(command => ({ ...this.fields(command, ["description"]),
        ...(command.input ? { input: this.fields(command.input, ["hint"]) } : {}) })) } };
      case "available_subagents_update": return { ...notification, update: { ...update, availableSubagents: update.availableSubagents.map(agent => this.fields(agent, ["description"])) } };
      case "background_tasks_update": return { ...notification, update: { ...update, tasks: update.tasks.map(task => this.fields(task, ["name", "command", "summary"], true)) } };
      case "workflow_progress_update": return { ...notification, update: { ...update, workflows: update.workflows.map(workflow => ({ ...this.fields(workflow, ["name"], true), phases: workflow.phases.map(phase => this.fields(phase, ["title"], true)) })) } };
      default: return notification;
    }
  }
  permission(request: RequestPermissionRequest): RequestPermissionRequest {
    return { ...this.fields(request, ["title", "contextItems"]), toolCall: this.tool(request.toolCall, true),
      options: request.options.map(option => this.fields(option, ["name"])) };
  }
  question(request: QuestionRequest): QuestionRequest {
    return { ...request, questions: request.questions.map(question => ({ ...this.fields(question, ["prompt", "header", "defaultFreeText", "approvalPrompt", "approvalTarget"]),
      options: question.options.map(option => ({...this.fields(option, ["label", "description", "preview"]),
        ...(option.externalAction ? {externalAction:this.fields(option.externalAction,["url"])} : {})})) })) };
  }
  /** Clone before teardown, retaining prototypes and recovery classifications. */
  error(error: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (!this.secrets.length) return error;
    if (!(error instanceof Error)) return this.value(error, "terminal");
    if (seen.has(error)) return seen.get(error);
    const result = error instanceof DOMException ? new DOMException(this.terminal(error.message), error.name)
      : Object.create(Object.getPrototypeOf(error)) as Error;
    seen.set(error, result);
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key === "stack") {
        Object.defineProperty(result, key, { value: this.value(error.stack, "terminal"), writable: true, configurable: true });
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(error, key)!;
      if ("value" in descriptor) {
        if (key === "cause") descriptor.value = this.error(descriptor.value, seen);
        else if (key === "errors" && Array.isArray(descriptor.value)) descriptor.value = descriptor.value.map(value => this.error(value, seen));
        else if (key === "failure") {
          descriptor.value = this.fields(descriptor.value, ["message", "advice"], "terminal");
          if (descriptor.value.exit) descriptor.value.exit = this.fields(descriptor.value.exit, ["stderrTail"], "terminal");
        } else if (!["name", "code", "kind", "stage", "agentId"].includes(key)) descriptor.value = this.value(descriptor.value, "terminal");
      }
      Object.defineProperty(result, key, descriptor);
    }
    return result;
  }
  stream(key: string, chunk: string): string {
    const raw = (this.pending.get(key) ?? "") + chunk;
    this.pending.delete(key);
    // Match complete literals first; a prefix of a different literal must not
    // split a complete match and cause its beginning to be published.
    const value = this.text(raw), keep = this.suffix(value);
    if (keep) {
      if (this.pending.size >= 256) { const oldest = this.pending.keys().next().value!; this.pending.delete(oldest); this.notifications.delete(oldest); }
      this.pending.set(key, value.slice(-keep));
    }
    return keep ? value.slice(0, -keep) : value;
  }
  finish(key: string): string {
    const remaining = this.pending.get(key) ?? "";
    this.pending.delete(key); this.notifications.delete(key);
    // A process can die in the middle of a literal. No terminal publication
    // may release a previously withheld credential prefix.
    return remaining ? "[redacted]" : "";
  }
  finishSession(sessionId: string): SessionNotification[] {
    const result: SessionNotification[] = [];
    for (const [key, notification] of this.notifications) {
      if (notification.sessionId !== sessionId) continue;
      const text = this.finish(key), update = notification.update;
      if (text && (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text")
        result.push({ ...notification, update: { ...update, content: { ...update.content, text } } });
    }
    return result;
  }
}
