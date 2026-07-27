// ──────────────────────────────────────────────────────────
// chat-title — background AI title for a chat's first prompt
// ──────────────────────────────────────────────────────────
//
// Fire-and-forget: when the FIRST user message of an "Untitled" chat is
// sent, this module asks the chat-title model (Settings → Models →
// "Custom models") for a 2–3 word title over the engine bridge
// (AGENT_GENERATE_TITLE) and renames the tab when it lands. There is
// deliberately NO instant prompt-snippet stage (2026-07-10 spec): the tab
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

import { getActiveBridge } from "../bridge/active-bridge";
import { deriveProviderEnv } from "../panels/provider-prefs";
import { getAgentsSnapshot } from "./agents-cache";
import { isRunnableAgent } from "./agent-runnable";
import { agentFamily } from "./model-catalog";
import {
  CHAT_TITLE_SYSTEM_PROMPT,
  resolveChatTitleModel,
} from "./new-chat-defaults";
import type { AgentTitleGeneratedMessage } from "../bridge/messages";
import type { Action } from "../store/workspace-store";

/** Ceiling on the prompt text sent to the title model — a title needs the
 *  gist, not a 100k-char paste, and small models are faster on less. */
const MAX_PROMPT_CHARS = 4_000;

/** Bridge round-trip budget. Codex boots a short-lived app-server (~2-5s)
 *  before its turn, so this is deliberately roomier than the UI feels. */
const REQUEST_TIMEOUT_MS = 45_000;

/** The model's reply is used as the tab title — enforce the 2–3 word
 *  contract defensively (small models occasionally add quotes, a trailing
 *  period, or a second line). Null = unusable reply, keep the snippet. */
export function sanitizeAiTitle(raw: string): string | null {
  let t = (raw.split("\n")[0] ?? "").trim();
  // Strip wrapping quotes/backticks and trailing sentence punctuation.
  t = t.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’.!?:…]+$/, "").trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  // Clamp to 3 words; the rejoin also collapses internal whitespace.
  t = words.slice(0, 3).join(" ");
  if (t.length > 60) t = t.slice(0, 60).trimEnd();
  // A title needs at least one letter or digit — a bare "…" is not one.
  return /[\p{L}\p{N}]/u.test(t) ? t : null;
}

/** Kick off the background AI title for a chat's first prompt. Synchronous
 *  and non-throwing by contract — call it inline in the send path. */
export function requestAiChatTitle(args: {
  chatId: string;
  agentId: string | null;
  /** The first user message's display text. */
  prompt: string;
  /** The title the tab currently shows (the seeded "Untitled") — the CAS
   *  expectation; a manual rename while generating wins. */
  expectedTitle: string;
  dispatch: (action: Action) => void;
}): void {
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
  if (!resolved || !args.prompt.trim()) return;
  const bridge = getActiveBridge();
  if (!bridge) return;
  void (async () => {
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
  })().catch((err) => {
    // Background best-effort — the tab keeps "Untitled". An old engine
    // (restart needed) surfaces here as "Unknown bridge message type".
    console.warn("[chat-title] request failed:", err);
  });
}
