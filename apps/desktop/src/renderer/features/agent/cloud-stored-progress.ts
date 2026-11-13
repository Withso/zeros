/** How often the active chat re-reads stored history while its turn runs without the live connection. */
export const STORED_PROGRESS_MS = 5_000;

export interface StoredProgressSources {
  /** The active, visible chat whose cloud turn is running in a running workspace, or null. */
  runningChat(): string | null;
  liveConnected(chatId: string): boolean;
  visible(): boolean;
  reread(chatId: string): void;
  subscribe(listener: () => void): () => void;
}

/** When the relay cannot reach a running VM, the worker still mirrors each turn's whole items to the server (its
 * message path is outbound, as Conductor's is). Re-read that stored history for the one active running chat on a
 * bounded clock, so the result arrives without the live stream. One clock at most; none while live is connected,
 * the window is hidden or no turn runs. R3's durable channel keeps this as its no-relay reader. */
export function watchStoredProgress(sources: StoredProgressSources): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined, armed: string | null = null;
  const due = () => {
    const chatId = sources.visible() ? sources.runningChat() : null;
    return chatId && !sources.liveConnected(chatId) ? chatId : null;
  };
  const arm = (chatId: string | null) => {
    clearTimeout(timer); timer = undefined; armed = chatId;
    if (!chatId) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (due() !== chatId) { evaluate(); return; }
      sources.reread(chatId);
      arm(chatId);
    }, STORED_PROGRESS_MS);
  };
  const evaluate = () => { const next = due(); if (next !== armed) arm(next); };
  const off = sources.subscribe(evaluate);
  evaluate();
  return () => { off(); clearTimeout(timer); timer = undefined; armed = null; };
}
