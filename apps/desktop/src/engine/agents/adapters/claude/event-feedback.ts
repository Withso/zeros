import { createHash, randomUUID } from "node:crypto";

const MAX_TEXT = 8_000;
const MAX_ROWS = 256;
const MAX_FRAMES = 4_000;
const MAX_PENDING = 64;

type Event = Record<string, unknown>;
export interface ClaudeFeedbackOwner {
  toolCallId: string;
  nativeParent?: string;
  terminal: boolean;
}
interface Feedback {
  key: string;
  text: string;
  toolId?: string;
  nativeParent?: string;
  insideTool?: boolean;
  activeOnly?: boolean;
}
interface Options {
  emit: (
    id: string,
    text: string,
    nativeParent?: string,
    parentToolId?: string,
  ) => void;
  owner: (
    toolId: string,
    nativeParent?: string,
  ) => ClaudeFeedbackOwner | undefined;
}

/** These are activity signals, not result/usage records. In particular a
 * thinking estimate proves neither a completed reply nor billed token usage. */
export function isClaudeParentProgress(event: Event): boolean {
  if (event.type !== "system" || event.parent_tool_use_id) return false;
  if (event.subtype === "status") {
    return event.status === "requesting" || event.status === "compacting";
  }
  return (
    event.subtype === "thinking_tokens" &&
    nonnegative(event.estimated_tokens) &&
    nonnegative(event.estimated_tokens_delta)
  );
}

/** Provider feedback uses ordinary commentary, never invented tools, auth
 * verdicts or turn completion. Raw login output and routine hook logs stay
 * private. Keep replay IDs across native results and query replacement. */
export class ClaudeEventFeedback {
  private readonly seen = new Set<string>();
  private readonly rows = new Map<
    string,
    { id: string; fingerprint: string }
  >();
  private readonly pending = new Map<string, Feedback>();
  private stopped = false;

  constructor(private readonly options: Options) {}

  beginTurn(): void {
    this.stopped = false;
    this.rows.clear();
  }
  result(): void {
    this.rows.clear();
  }
  stop(): void {
    this.stopped = true;
    this.pending.clear();
    this.rows.clear();
  }

  /** Retry attribution once native tool identity is available. Never borrow a
   * parent's or a sibling's row when the producer omitted ownership. */
  flushTools(): void {
    if (this.stopped) return;
    for (const [key, feedback] of this.pending) {
      if (this.publish(feedback)) this.pending.delete(key);
    }
  }

  /** True includes intentionally quiet variants of a recognized event. */
  feed(event: Event): boolean {
    const kind = event.type === "system" ? event.subtype : event.type;
    if (
      !FEEDBACK_EVENTS.has(
        `${event.type === "system" ? "system/" : ""}${String(kind)}`,
      )
    )
      return false;
    if (this.stopped) return true;
    const uuid = identity(event.uuid);
    if (uuid && this.seen.has(uuid)) return true;
    if (uuid) {
      this.seen.add(uuid);
      if (this.seen.size > MAX_FRAMES)
        this.seen.delete(this.seen.values().next().value!);
    }
    const notice = (
      value: unknown,
      key = `${kind}:${uuid ?? digest(text(value))}`,
    ) => {
      const body = text(value);
      if (body) this.publish({ key, text: body });
    };
    const toolNotice = (
      value: unknown,
      key: string,
      insideTool = false,
      activeOnly = false,
    ) => {
      const toolId = identity(event.tool_use_id);
      const body = text(value);
      if (!toolId || !body) return;
      const feedback = {
        key: digest(JSON.stringify([key, toolId, event.parent_tool_use_id])),
        text: body,
        toolId,
        insideTool,
        activeOnly,
        ...(event.parent_tool_use_id === null
          ? { nativeParent: "" }
          : identity(event.parent_tool_use_id)
            ? { nativeParent: event.parent_tool_use_id as string }
            : {}),
      };
      if (!this.publish(feedback)) {
        boundedSet(this.pending, feedback.key, feedback, MAX_PENDING);
      }
    };
    switch (kind) {
      case "informational":
        if (identity(event.tool_use_id))
          toolNotice(
            event.content,
            `information:${identity(event.tool_use_id)}`,
          );
        else notice(event.content);
        break;
      case "notification":
        notice(
          event.text,
          `notification:${identity(event.key) ?? uuid ?? randomUUID()}`,
        );
        break;
      case "model_refusal_no_fallback": {
        const requestId = identity(event.request_id);
        notice(
          text(event.content) || event.api_refusal_explanation,
          `refusal:${requestId ?? uuid ?? randomUUID()}`,
        );
        break;
      }
      case "hook_response":
        if (event.outcome === "error") {
          const name = text(event.hook_name, 160) || "Claude";
          const detail = text(event.output) || text(event.stderr);
          notice(
            `Hook ${name} failed.${detail ? ` ${detail}` : ""}`,
            `hook:${identity(event.hook_id) ?? uuid ?? randomUUID()}`,
          );
        }
        break;
      case "hook_started":
      case "hook_progress":
      case "tool_use_summary":
        // Ordinary activity already has a loader/tool row. These are not
        // authoritative outcomes, and hook stdout can contain private data.
        break;
      case "permission_denied":
        toolNotice(
          text(event.message) || event.decision_reason,
          `permission:${identity(event.tool_use_id) ?? uuid}`,
        );
        break;
      case "tool_progress": {
        const retry = record(event.subagent_retry);
        if (retry && nonnegative(retry.attempt) && Number(retry.attempt) > 0) {
          toolNotice(
            "Agent connection interrupted — retrying automatically…",
            `agent-retry:${identity(event.tool_use_id)}:${identity(retry.agent_id) ?? ""}`,
            true,
            true,
          );
        }
        // Heartbeats do not complete tools, reset parent retry bursts, or
        // expose duration counters in the collapsed row.
        break;
      }
      case "auth_status":
        if (event.error)
          notice(
            "Claude authentication failed. Check Settings → Providers → Claude.",
            "authentication",
          );
        else if (event.isAuthenticating === true)
          notice("Claude authentication is in progress.", "authentication");
        else if (
          event.isAuthenticating === false &&
          this.rows.has("authentication")
        )
          notice("Claude authentication finished.", "authentication");
        break;
      case "plugin_install":
        if (event.status === "started")
          notice("Installing Claude plugins…", "plugin-install");
        else if (event.status === "completed")
          notice("Claude plugin installation finished.", "plugin-install");
        else if (event.status === "failed") {
          const name = text(event.name, 160) || "a plugin";
          const detail = text(event.error);
          notice(
            `Claude could not install ${name}.${detail ? ` ${detail}` : ""}`,
            `plugin-failed:${identity(event.name) ?? uuid ?? randomUUID()}`,
          );
        }
        break;
      case "rate_limit_event": {
        const info = record(event.rate_limit_info);
        if (!info) break;
        const key = `rate-limit:${identity(info.rateLimitType) ?? "account"}`;
        if (info.isUsingOverage === true || info.overageInUse === true) {
          notice("Claude is using extra usage.", key);
        } else if (info.status === "allowed_warning") {
          notice("Claude is nearing its usage limit.", key);
        } else if (info.status === "rejected") {
          notice(
            info.overageStatus === "allowed" ||
              info.overageStatus === "allowed_warning"
              ? "Claude has reached its included usage limit. Extra usage is available."
              : "Claude has reached its usage limit. Wait for the limit to reset before retrying.",
            key,
          );
        } else if (info.status === "allowed" && this.rows.has(key)) {
          notice("Claude usage is available again.", key);
        }
        break;
      }
      case "files_persisted":
        if (Array.isArray(event.failed) && event.failed.length > 0)
          notice("Claude could not persist some session files.");
        break;
      case "mirror_error":
        if (text(event.error))
          notice("Claude could not synchronize its session details.");
        break;
      case "elicitation_complete":
        if (identity(event.elicitation_id)) {
          const name = text(event.mcp_server_name, 160) || "The MCP server";
          notice(
            `${name} completed its external request.`,
            `elicitation:${digest(name)}:${identity(event.elicitation_id)}`,
          );
        }
        break;
    }
    return true;
  }

  private publish(feedback: Feedback): boolean {
    const owner = feedback.toolId
      ? this.options.owner(feedback.toolId, feedback.nativeParent)
      : undefined;
    if (feedback.toolId && !owner) return false;
    if (feedback.activeOnly && owner?.terminal) return true;
    const body = text(feedback.text);
    if (!body) return true;
    const key = digest(JSON.stringify([feedback.key, owner?.toolCallId]));
    // Named non-tool lifecycles are also addressed by their native key so a
    // terminal update can determine whether a corresponding start was seen.
    const rowKey = feedback.toolId ? key : feedback.key;
    const fingerprint = digest(body);
    const previous = this.rows.get(rowKey);
    if (previous?.fingerprint === fingerprint) return true;
    const id = previous?.id ?? `claude-feedback-${randomUUID()}`;
    boundedSet(this.rows, rowKey, { id, fingerprint }, MAX_ROWS);
    this.options.emit(
      id,
      body,
      feedback.insideTool ? undefined : owner?.nativeParent,
      feedback.insideTool ? owner?.toolCallId : undefined,
    );
    return true;
  }
}

const FEEDBACK_EVENTS = new Set([
  "system/informational",
  "system/notification",
  "system/model_refusal_no_fallback",
  "system/hook_started",
  "system/hook_progress",
  "system/hook_response",
  "system/permission_denied",
  "tool_progress",
  "auth_status",
  "system/plugin_install",
  "rate_limit_event",
  "system/files_persisted",
  "system/mirror_error",
  "system/elicitation_complete",
  "tool_use_summary",
]);
function text(value: unknown, limit = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  const clipped = value.slice(0, limit).trim();
  return value.length > limit && clipped ? `${clipped}… [truncated]` : clipped;
}
function identity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}
function record(value: unknown): Event | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Event)
    : undefined;
}
function nonnegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function boundedSet<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}
