// Claude Code stream → SessionNotification translator.
//
// This is the ONLY surviving piece of the former per-turn `claude -p`
// adapter. The SDK adapter (../claude-sdk) reuses this translator because
// the Agent SDK's SDKMessage shapes mirror the raw stream-json events
// (system/assistant/user/result), so one translator serves both.
//
// The legacy stream-json adapter itself — spec.ts (claudeSpec), hooks.ts
// (HTTP permission hooks) and history.ts (JSONL replay), plus
// createClaudeAdapter — was REMOVED. Claude now runs EXCLUSIVELY through
// @anthropic-ai/claude-agent-sdk (see registry.ts → createClaudeSdkAdapter).
// There is intentionally no fallback path, so there is only one Claude code
// path to reason about.

export { ClaudeStreamTranslator } from "./translator";
export type { ClaudeTranslatorOptions } from "./translator";
