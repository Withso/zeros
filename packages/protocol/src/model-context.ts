// Claude's SDK model registry informs this shared engine and attachment fallback. Keep redundant [1m] catalog IDs for native-1M models because persisted chats reference them.

/** Use Claude's conservative 200K family floor for an unknown model. */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;

const ONE_MILLION = 1_000_000;

/** Match native 1M models by base ID so dated and suffixed snapshots also match. */
const CLAUDE_NATIVE_1M =
  /claude-(?:fable-5|mythos-5|opus-5|opus-4-[78]|sonnet-5)/i;

/** Both [1m] and -1m are supported request suffixes. */
const CLAUDE_1M_SUFFIX = /(?:\[1m\]|-1m)\s*$/i;

/** Haiku advertises a suffix without usable 1M context; match it before the suffix rule. */
const CLAUDE_HAIKU = /claude-haiku/i;

/** Pre-runtime fallback in tokens; a measured runtime window takes precedence. */
export function claudeContextWindow(modelId: string | null | undefined): number {
  if (!modelId) return CLAUDE_DEFAULT_CONTEXT_WINDOW;
  const id = modelId.trim();
  if (CLAUDE_HAIKU.test(id)) return CLAUDE_DEFAULT_CONTEXT_WINDOW;
  if (CLAUDE_NATIVE_1M.test(id)) return ONE_MILLION;
  // Older Opus 4.5, 4.1 and 4.0 advertise the suffix without a 1M beta, but unlike Haiku still fall through to this estimate.
  if (CLAUDE_1M_SUFFIX.test(id)) return ONE_MILLION;
  return CLAUDE_DEFAULT_CONTEXT_WINDOW;
}
