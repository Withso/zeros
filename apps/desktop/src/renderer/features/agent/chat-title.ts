// ──────────────────────────────────────────────────────────
// chat-title — background AI title for a chat's first prompt
// ──────────────────────────────────────────────────────────
//
// Fire-and-forget: after the FIRST user message of an "Untitled" chat has
// actually been admitted and its turn settles, this module asks the chat-title model (Settings → Models →
// "Custom models") for a 2–3 word title over the engine bridge
// (AGENT_GENERATE_TITLE) and renames the tab when it lands. There is
// deliberately no instant prompt-snippet stage: the tab
// stays "Untitled" until the AI title arrives — slow is acceptable, the
// raw prompt text is not.
//
// Invisible-by-design contract:
//   - Never blocks or delays the real turn — the request runs entirely in
//     the background and every failure path leaves the seeded title (loud
//     in DevTools only).
//   - Never clobbers the user: the swap is a compare-and-swap dispatch
//     (UPDATE_CHAT_TITLE_IF) that only applies while the tab still shows
//     the exact title this call raced (the seeded "Untitled").
//   - Rides the same auth as a normal chat spawn (deriveProviderEnv), so
//     if the user can chat with the provider at all, the title call works.
// ──────────────────────────────────────────────────────────

import type { AgentMessage } from "@zeros/protocol/agent-messages";

import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { deriveProviderEnv } from "../settings/provider-prefs";
import { getAgentsSnapshot } from "./agents-cache";
import { isRunnableAgent } from "./agent-runnable";
import { agentFamily } from "./model-catalog";
import {
  CHAT_TITLE_SYSTEM_PROMPT,
  resolveChatTitleModel,
} from "./new-chat-defaults";
import type { AgentTitleGeneratedMessage } from "../../platform/bridge/messages";
import type { Action } from "../../state/workspace-store";
import type { SessionStatus } from "./use-agent-session";
import { scheduleChatTitleWork } from "./chat-title-scheduler";

/** Ceiling on the prompt text sent to the title model — a title needs the
 *  gist, not a 100k-char paste, and small models are faster on less. */
const MAX_PROMPT_CHARS = 4_000;

/** Bridge round-trip budget. Codex boots a short-lived app-server (~2-5s)
 *  before its turn, so this is deliberately roomier than the UI feels. */
const REQUEST_TIMEOUT_MS = 45_000;

/** A provider can occasionally return its own failure text through a nominal
 * success/result channel. Never persist that diagnostic as the chat title. */
const PROVIDER_DIAGNOSTIC_TITLE_RX =
  /^(?:error\b|fatal\b|failed\s+to\b|(?:user\s+)?authentication\s+(?:failed|error)\b|unauthori[sz]ed\b|please\s+(?:sign|log)\s+in\b|request\s+(?:failed|timed\s+out|timeout)\b|connection\s+(?:closed|failed|refused|reset)\b)/i;

/** Select the first real user prompt only after admission and turn teardown
 * have returned the session to ready. A queued placeholder is renderer-local
 * intent, not proof that the provider received anything; generating a title
 * from it made the tab look successful while the actual prompt was stalled. */
export function settledFirstPromptForTitle(input: {
  status: SessionStatus;
  messages: readonly AgentMessage[];
}): { messageId: string; prompt: string } | null {
  if (input.status !== "ready") return null;
  for (const message of input.messages) {
    if (message.kind !== "text" || message.role !== "user") continue;
    if (message.queued || !message.text.trim()) return null;
    return { messageId: message.id, prompt: message.text };
  }
  return null;
}

/** The model's reply is used as the tab title — enforce the 2–3 word
 *  contract defensively (small models occasionally add quotes, a trailing
 *  period, or a second line). Null = unusable reply, keep the snippet. */
export function sanitizeAiTitle(raw: string): string | null {
  let t = (raw.split("\n")[0] ?? "").trim();
  // Strip wrapping quotes/backticks and trailing sentence punctuation.
  t = t
    .replace(/^["'`“”‘’]+/, "")
    .replace(/["'`“”‘’.!?:…]+$/, "")
    .trim();
  if (PROVIDER_DIAGNOSTIC_TITLE_RX.test(t)) return null;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  // Clamp to 3 words; the rejoin also collapses internal whitespace.
  t = words.slice(0, 3).join(" ");
  if (t.length > 60) t = t.slice(0, 60).trimEnd();
  // A title needs at least one letter or digit — a bare "…" is not one.
  return /[\p{L}\p{N}]/u.test(t) ? t : null;
}

/** Queue the background AI title for a chat's settled first prompt.
 *  Synchronous and non-throwing by contract. Returns true only when work was
 *  scheduled, allowing the caller to retain an exact-message
 *  single-flight guard without suppressing a later bridge-ready retry. */
export function requestAiChatTitle(args: {
  chatId: string;
  agentId: string | null;
  /** The first user message's display text. */
  prompt: string;
  /** The title the tab currently shows (the seeded "Untitled") — the CAS
   *  expectation; a manual rename while generating wins. */
  expectedTitle: string;
  dispatch: (action: Action) => void;
}): boolean {
  // Connectivity snapshot → the resolver's fallback chain (Haiku → Luna →
  // Composer 2.5). Null (registry not loaded yet) = trust the saved pick.
  const agents = getAgentsSnapshot();
  const connectedFamilies = agents
    ? new Set(
        agents
          .filter(isRunnableAgent)
          .map((a) => agentFamily(a.id))
          .filter((f) => f !== ""),
      )
    : null;
  const resolved = resolveChatTitleModel(args.agentId, connectedFamilies);
  if (!resolved || !args.prompt.trim()) return false;
  if (!getActiveBridge()) return false;
  scheduleChatTitleWork(args.chatId, async () => {
    const bridge = getActiveBridge();
    if (!bridge) return;
    // Family === engine agent id (claude/codex/cursor) — the same identity
    // mapping new-chat-defaults' settings mirror relies on.
    const env = await deriveProviderEnv(resolved.family);
    const resp = await bridge.request<AgentTitleGeneratedMessage>(
      {
        type: "AGENT_GENERATE_TITLE",
        agentId: resolved.family,
        model: resolved.model,
        systemPrompt: CHAT_TITLE_SYSTEM_PROMPT,
        prompt: args.prompt.slice(0, MAX_PROMPT_CHARS),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
      REQUEST_TIMEOUT_MS,
    );
    if (resp.type !== "AGENT_TITLE_GENERATED") return;
    if (!resp.title) {
      // Silent for the user (the tab keeps "Untitled") but LOUD in DevTools —
      // otherwise "failed" and "still generating" are indistinguishable.
      console.warn(
        `[chat-title] ${resolved.family}/${resolved.model} returned no title` +
          (resp.error ? `: ${resp.error}` : ""),
      );
      return;
    }
    const title = sanitizeAiTitle(resp.title);
    if (!title) {
      console.warn(
        `[chat-title] unusable reply from ${resolved.family}/${resolved.model}:`,
        JSON.stringify(resp.title.slice(0, 120)),
      );
      return;
    }
    args.dispatch({
      type: "UPDATE_CHAT_TITLE_IF",
      id: args.chatId,
      title,
      expectedTitle: args.expectedTitle,
    });
  });
  return true;
}
