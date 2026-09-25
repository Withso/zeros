// Cosmetic naming uses the authenticated control plane, independently of the
// chat provider. Only the first admitted prompt's bounded display text leaves
// the renderer. Missing credentials, offline service, and bad replies are quiet.
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { getSession, onAuthStateChange } from "../auth/auth-store";
import { CONTROL_PLANE_URL } from "../team/control-plane";
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
    !/[\p{Cc}\p{Cf}<>\[\]{}*`]/u.test(result)
    ? result
    : null;
}

/** One HTTP attempt per chat/message, including remounts. Both the exact owner and
 * seeded title must still match after the response; a manual rename wins. */
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
  void (async () => {
    try {
      const session = await getSession();
      if (!session?.access_token || attempts.get(key) !== entry || !current())
        return;
      entry.requested = true;
      const response = await fetch(`${CONTROL_PLANE_URL}/v1/chat-titles`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chatId: args.chatId,
          messageId: args.messageId,
          prompt,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("title" in result) ||
        typeof result.title !== "string"
      )
        return;
      const title = sanitizeAiTitle(result.title);
      if (!title || !current()) return;
      const liveSession = await getSession();
      if (
        !liveSession ||
        liveSession.user.sub !== session.user.sub ||
        liveSession.user.provider !== session.user.provider ||
        !current()
      )
        return;
      args.dispatch({
        type: "UPDATE_CHAT_TITLE_IF",
        id: args.chatId,
        title,
        expectedTitle: args.expectedTitle,
      });
    } catch {
      // Cosmetic failure: keep the seeded title. Never log prompt or response.
    } finally {
      entry.pending = false;
      // Session restoration/sign-in can finish after the first eligible render.
      // No server request happened, so a later auth event may still name the chat.
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
