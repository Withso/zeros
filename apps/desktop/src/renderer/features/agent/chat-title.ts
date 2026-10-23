// Cosmetic naming uses the authenticated control plane, independently of the
// chat provider. Only the first admitted prompt's bounded display text leaves
// the renderer. Missing credentials, offline service, and bad replies are quiet.
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { getSession, onAuthStateChange } from "../auth/auth-store";
import { CONTROL_PLANE_URL } from "../team/control-plane";
import { controlPlaneFetch } from "../update/control-plane-fetch";
import { useWorkspaceStore, type Action } from "../../state/workspace-store";
import type { SessionStatus } from "./use-agent-session";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 1_000;
const attempts = new Map<string, { pending: boolean; requested: boolean }>();

/** Code points, not UTF-16 halves. No separator expands the 500-character cap. */
export function compactTitlePrompt(prompt: string): string {
  const chars = Array.from(prompt.trim());
  return chars.length <= 500
    ? chars.join("")
    : chars.slice(0, 400).join("") + chars.slice(-100).join("");
}

/** Select the chat's first real user prompt once the provider has proved it
 * received it: the turn settled back to ready, or the agent already answered
 * it (a coordinator's first turn can run for an hour and go straight into the
 * next one). A queued placeholder is renderer-local intent, not proof that
 * the provider received anything; generating a title from it made the tab
 * look successful while the actual prompt was stalled.
 *
 * Only the window's opening message qualifies: a long transcript re-windows
 * to its tail, whose first user row is a later prompt. A Zeros Local note is
 * never the user's prompt. */
export function settledFirstPromptForTitle(input: {
  status: SessionStatus;
  messages: readonly AgentMessage[];
}): { messageId: string; prompt: string } | null {
  // Rows that are not conversation can precede the first prompt: a provider
  // notice (Codex reports config/deprecation warnings at session start), a
  // model-fallback announcement, a divider. Anything else first means the
  // window starts mid-transcript.
  let index = 0;
  while (index < input.messages.length) {
    const message = input.messages[index]!;
    const preamble =
      message.kind === "error_notice" ||
      (message.kind === "text" && (message.role === "system" || message.retracted === true || message.modelFallback !== undefined));
    if (!preamble) break;
    index++;
  }
  const first = input.messages[index];
  if (!first || first.kind !== "text" || first.role !== "user") return null;
  if (first.queued || first.localNote || !first.text.trim()) return null;
  const answered = input.messages
    .slice(index + 1)
    .some((m) => m.kind === "tool" || (m.kind === "text" && m.role === "agent" && !m.modelFallback && m.text.trim().length > 0));
  if (input.status !== "ready" && !answered) return null;
  return { messageId: first.id, prompt: first.text };
}

/** Defensive response validation; the backend owns generation and sanitation. */
export function sanitizeAiTitle(raw: string): string | null {
  const title = (raw.trim().split(/\r?\n/)[0] ?? "")
    .replace(/^["'`“”‘’]+|["'`“”‘’.!?:…]+$/g, "")
    .trim();
  if (
    /^(?:error\b|fatal\b|failed to\b|(?:user )?authentication (?:failed|error)\b|unauthori[sz]ed\b|please (?:sign|log) in\b|request (?:failed|timed out|timeout)\b|connection (?:closed|failed|refused|reset)\b)/i.test(
      title,
    )
  )
    return null;
  const words = title.split(/\s+/).filter(Boolean).slice(0, 5);
  const result = words.join(" ");
  return words.length >= 3 &&
    Array.from(result).length <= 80 &&
    words.every((word) => /[\p{L}\p{N}]/u.test(word)) &&
    !/[\p{Cc}\p{Cf}<>[\]{}*`]/u.test(result)
    ? result
    : null;
}

/** A title from the prompt's own opening words, for when the service cannot
 * name the chat: better than leaving it Untitled for good. */
export function fallbackChatTitle(prompt: string): string | null {
  for (const raw of prompt.split(/\r?\n/)) {
    const words = raw
      .replace(/\bzeros(?:-alpha|-beta|-dev)?:\/\/\S+/g, " ")
      .replace(/[`*_#>]/g, "")
      .split(/\s+/)
      .filter((word) => /[\p{L}\p{N}]/u.test(word))
      .slice(0, 6);
    const title = words.join(" ").replace(/["'“”‘’.!?:;,…]+$/u, "").trim();
    if (!title) continue;
    const chars = Array.from(title);
    return chars.length > 60 ? chars.slice(0, 59).join("") + "…" : title;
  }
  return null;
}

/** Spacing before the second and third request. A transient failure (busy,
 * unreachable, a timeout, a reply too short to be a title) gets two more tries;
 * then the prompt names the chat. A 401 waits for a fresh sign-in. */
const RETRY_DELAYS_MS = [10_000, 60_000] as const;

type TitleTry = "titled" | "retry" | "give-up" | "unauthorized" | "quiet";

/** At most one naming flight per chat/message, including remounts. Both the
 * exact owner and seeded title must still match after each response; a manual
 * rename wins, and stops any retry. */
export function requestAiChatTitle(
  args: {
    chatId: string;
    messageId: string;
    prompt: string;
    expectedTitle: string;
    dispatch: (action: Action) => void;
  },
  authChanged = false,
): boolean {
  if (!CONTROL_PLANE_URL || !args.prompt.trim()) return false;
  const original = useWorkspaceStore
    .getState()
    .chats.find((chat) => chat.id === args.chatId);
  if (!original || original.title !== args.expectedTitle) return false;
  const { folder, createdAt } = original;
  const current = () => {
    const chat = useWorkspaceStore
      .getState()
      .chats.find((chat) => chat.id === args.chatId);
    return (
      chat &&
      chat.folder === folder &&
      chat.createdAt === createdAt &&
      chat.title === args.expectedTitle
    );
  };
  const key = JSON.stringify([args.chatId, folder, createdAt, args.messageId]);
  const existing = attempts.get(key);
  // A sign-in may overtake an older native session lookup. Supersede only
  // unpaid auth work; an HTTP request is never restarted by an auth event.
  if (existing && !(authChanged && existing.pending && !existing.requested))
    return true;
  if (!existing && attempts.size >= MAX_ATTEMPTS) {
    const oldest = [...attempts].find(([, entry]) => !entry.pending);
    if (!oldest) return false;
    attempts.delete(oldest[0]);
  }
  const entry = { pending: true, requested: false };
  attempts.set(key, entry);
  // Bound the display text before any remote call.
  const prompt = compactTitlePrompt(args.prompt);
  const once = async (messageId: string): Promise<TitleTry> => {
    try {
      const session = await getSession();
      if (!session?.access_token || attempts.get(key) !== entry || !current())
        return "quiet";
      const response = await controlPlaneFetch(`${CONTROL_PLANE_URL}/v1/chat-titles`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ chatId: args.chatId, messageId, prompt }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      }, () => {
        if (attempts.get(key) !== entry || !current()) throw new Error("The chat changed before the title request");
        entry.requested = true;
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) return "unauthorized";
        // Busy or down: try again. Any other refusal will not change.
        return response.status === 429 || response.status >= 500 ? "retry" : "give-up";
      }
      const result: unknown = await response.json();
      const raw =
        result && typeof result === "object" && "title" in result && typeof result.title === "string"
          ? result.title
          : null;
      const title = raw === null ? null : sanitizeAiTitle(raw);
      if (!title) return current() ? "retry" : "quiet";
      if (!current()) return "quiet";
      const liveSession = await getSession();
      if (
        !liveSession ||
        liveSession.user.sub !== session.user.sub ||
        liveSession.user.provider !== session.user.provider ||
        !current()
      )
        return "quiet";
      args.dispatch({
        type: "UPDATE_CHAT_TITLE_IF",
        id: args.chatId,
        title,
        expectedTitle: args.expectedTitle,
      });
      return "titled";
    } catch {
      // Cosmetic failure. Never log prompt or response.
      return entry.requested && current() ? "retry" : "quiet";
    }
  };
  void (async () => {
    try {
      for (let index = 0; ; index++) {
        // A retry asks again under its own id: the service remembers a failed
        // answer for the original one.
        const outcome = await once(index === 0 ? args.messageId : `${args.messageId}#${index + 1}`);
        if (outcome === "give-up") {
          const title = fallbackChatTitle(args.prompt);
          if (title && current()) args.dispatch({ type: "UPDATE_CHAT_TITLE_IF", id: args.chatId, title, expectedTitle: args.expectedTitle });
          return;
        }
        if (outcome !== "retry") {
          // Nothing was paid for (or the session was refused): a later
          // sign-in may still name the chat.
          if ((outcome === "quiet" && !entry.requested) || outcome === "unauthorized") entry.requested = false;
          return;
        }
        const delay = RETRY_DELAYS_MS[index];
        if (delay === undefined) {
          const title = fallbackChatTitle(args.prompt);
          if (title && current()) args.dispatch({ type: "UPDATE_CHAT_TITLE_IF", id: args.chatId, title, expectedTitle: args.expectedTitle });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (attempts.get(key) !== entry || !current()) return;
      }
    } finally {
      entry.pending = false;
      // Session restoration/sign-in can finish after the first eligible render.
      // No paid request settled the chat, so a later auth event may name it.
      if (!entry.requested && attempts.get(key) === entry) attempts.delete(key);
    }
  })();
  return true;
}

/** Start from an active chat effect and wake once auth becomes available.
 * The returned cleanup keeps retained hidden chats inert. Paid requests remain
 * deduplicated by requestAiChatTitle, even across repeated auth notifications. */
export function startChatTitleRequest(
  args: Parameters<typeof requestAiChatTitle>[0],
): () => void {
  let active = true;
  const request = (authChanged = false) => {
    if (active) requestAiChatTitle(args, authChanged);
  };
  const unsubscribe = onAuthStateChange((session) => {
    if (session) request(true);
  });
  request();
  return () => {
    active = false;
    unsubscribe();
  };
}
