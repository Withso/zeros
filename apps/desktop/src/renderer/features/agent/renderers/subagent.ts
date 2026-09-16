// ──────────────────────────────────────────────────────────
// subagent — detect a parent agent delegating to a child
// ──────────────────────────────────────────────────────────
//
// A delegation shows up in the stream as a regular ToolCall.
// claude-agent-sdk's built-in is "Task"; other agents name it
// differently. Match permissively by title or by rawInput
// carrying a subagent_type key.
//
// Extracted from agent-chat.tsx; behavior unchanged.
//
// ──────────────────────────────────────────────────────────

import type { AgentToolMessage } from "../use-agent-session";

const SUBAGENT_TITLE_PATTERN = /^(task|spawn_?agent|delegate|subagent)$/i;

export interface SubagentInfo {
  /** Which subagent role the parent agent is invoking, if declared. */
  subagentType?: string;
  /** One-line description of the job the parent handed off. */
  description?: string;
}

export function matchSubagent(tool: AgentToolMessage): SubagentInfo | null {
  // Keep Cursor's persisted kind routed through its compatibility renderer;
  // that renderer now shares the same Agent group presentation.
  if (tool.toolKind === "task") return null;
  const input = tool.rawInput as
    | {
        type?: string;
        agentThreadId?: string;
        agentPath?: string;
        subagent_type?: string;
        // Cursor's `task` tool carries the role as `subagentType: { kind }`
        // (camelCase) — distinct from Claude's `subagent_type` (snake) string.
        subagentType?: { kind?: string; name?: string } | string;
        description?: string;
        prompt?: string;
      }
    | undefined;
  // Compatibility with stored rows from before Codex's activity variant had
  // a native mapping. This changes presentation only, not historical status
  // or ownership that was never captured.
  if (
    input?.type === "subAgentActivity" &&
    typeof input.agentThreadId === "string" &&
    typeof input.agentPath === "string"
  ) {
    const name = input.agentPath
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/[_-]+/g, " ");
    return {
      description: name ? name[0].toUpperCase() + name.slice(1) : undefined,
    };
  }
  // The role name, normalizing Claude's string form and Cursor's { kind } form.
  const subagentType =
    typeof input?.subagent_type === "string"
      ? input.subagent_type
      : typeof input?.subagentType === "string"
        ? input.subagentType
        : input?.subagentType?.kind;
  const description =
    input?.description ??
    (typeof input?.prompt === "string"
      ? input.prompt.slice(0, 160)
      : undefined);

  // Match by the (agent-specific) title vocabulary OR by carrying a subagent
  // role field — so a Cursor `task` (title "Subagent …", `subagentType.kind`)
  // routes to the SubagentCard even when its toolKind wasn't tagged
  // `subagent` (older/persisted chats, generic fallbacks).
  if (SUBAGENT_TITLE_PATTERN.test(tool.title) || subagentType) {
    return { subagentType, description };
  }
  return null;
}
