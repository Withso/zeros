// Cosmetic title generation may boot a second provider process. Keep it well
// outside the user's post-turn interaction window and serialize it across
// chats so an "Untitled" rename can never fan out into competing cold starts.

export const CHAT_TITLE_IDLE_GRACE_MS = 15_000;

type ChatTitleWork = () => Promise<void>;

interface ChatTitleSchedulerState {
  queued: Map<string, ChatTitleWork>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  notBefore: number;
  generation: number;
}

type ChatTitleSchedulerGlobal = typeof globalThis & {
  __zerosChatTitleSchedulerV1__?: ChatTitleSchedulerState;
};

// Vite can replace this module while an old idle timer is still armed. Keep
// the coordinator renderer-global so replacement code cancels/reuses that
// exact timer and queue instead of booting a second title provider later.
const schedulerGlobal = globalThis as ChatTitleSchedulerGlobal;
const state =
  schedulerGlobal.__zerosChatTitleSchedulerV1__ ??
  (schedulerGlobal.__zerosChatTitleSchedulerV1__ = {
    queued: new Map<string, ChatTitleWork>(),
    timer: null,
    running: false,
    notBefore: 0,
    generation: 0,
  });

function clearTimer(): void {
  if (!state.timer) return;
  clearTimeout(state.timer);
  state.timer = null;
}

function arm(): void {
  if (state.timer || state.running || state.queued.size === 0) return;
  const delay = Math.max(0, state.notBefore - Date.now());
  state.timer = setTimeout(() => {
    state.timer = null;
    void runNext();
  }, delay);
}

async function runNext(): Promise<void> {
  if (state.running || state.queued.size === 0) return;
  if (Date.now() < state.notBefore) {
    arm();
    return;
  }
  const next = state.queued.entries().next().value as
    | [string, ChatTitleWork]
    | undefined;
  if (!next) return;
  const [chatId, work] = next;
  state.queued.delete(chatId);
  state.running = true;
  const runGeneration = state.generation;
  try {
    await work();
  } catch (error) {
    console.warn("[chat-title] request failed:", error);
  } finally {
    if (runGeneration === state.generation) {
      state.running = false;
      arm();
    }
  }
}

/** Schedule or replace one title request for a chat. A newly settled turn is
 * itself activity, so every queued title shares a fresh quiet window. */
export function scheduleChatTitleWork(
  chatId: string,
  work: ChatTitleWork,
): void {
  state.queued.set(chatId, work);
  state.notBefore = Date.now() + CHAT_TITLE_IDLE_GRACE_MS;
  clearTimer();
  arm();
}

/** Called at the first synchronous edge of Send. Pending cosmetic work waits
 * through another full quiet window; a title already executing is allowed to
 * finish, while every queued title remains serialized behind it. */
export function noteInteractiveAgentActivity(): void {
  if (state.queued.size === 0) return;
  state.notBefore = Date.now() + CHAT_TITLE_IDLE_GRACE_MS;
  clearTimer();
  arm();
}

export function resetChatTitleSchedulerForTests(): void {
  state.generation += 1;
  clearTimer();
  state.queued.clear();
  state.running = false;
  state.notBefore = 0;
}
