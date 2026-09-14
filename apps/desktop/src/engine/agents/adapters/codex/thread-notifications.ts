import type { CodexAppServerTranslator } from "./app-server-translator";

export class CodexThreadNotifications {
  private readonly children = new Map<string, CodexAppServerTranslator>();
  private readonly turns = new Map<string, string>();
  private readonly retiredTurns = new Map<string, Set<string>>();
  constructor(
    private readonly threadId: string,
    private readonly root: CodexAppServerTranslator,
  ) {}

  hasThread(threadId: unknown): boolean {
    return (
      typeof threadId === "string" &&
      (threadId === this.threadId || this.children.has(threadId))
    );
  }

  handle(method: string, params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      turn?: { id?: string };
      thread?: { id?: string };
      item?: {
        id?: string;
        type?: string;
        tool?: string;
        receiverThreadIds?: string[];
      };
    } | null;
    const threadId =
      p?.threadId ??
      (method === "thread/started" ? p?.thread?.id : undefined) ??
      this.threadId;
    const translator = this.forThread(threadId);
    const turnId = p?.turnId ?? p?.turn?.id;
    if (method === "turn/started" && turnId) {
      const previous = this.turns.get(threadId);
      const retired = this.retiredTurns.get(threadId) ?? new Set<string>();
      if (retired.has(turnId)) return;
      if (previous && previous !== turnId) {
        retired.add(previous);
        if (retired.size > 128) retired.delete(retired.values().next().value!);
        this.retiredTurns.set(threadId, retired);
      }
      // User prompts already reset the root before turn/start. Native parent
      // continuations have no adapter prompt call, so retire their prior
      // terminal state here just as we do for child turns.
      if (
        previous !== turnId &&
        (threadId !== this.threadId || translator.sawTurnTerminal)
      )
        translator.startTurn();
      this.turns.set(threadId, turnId);
    }
    // Item ids can be reused in the next turn. Once that turn starts, stale
    // frames cannot mutate its records or control state. Late bookkeeping
    // before the next turn still flows through the original translator state.
    if (
      turnId &&
      this.turns.has(threadId) &&
      this.turns.get(threadId) !== turnId
    )
      return;
    translator.handle(method, params);
    const item = p?.item;
    if (
      item?.type === "collabAgentToolCall" &&
      item.tool === "spawnAgent" &&
      item.id
    ) {
      const parent = translator.toolCallIdFor(item.id);
      if (parent && Array.isArray(item.receiverThreadIds)) {
        for (const receiver of item.receiverThreadIds) {
          if (
            typeof receiver === "string" &&
            receiver !== threadId &&
            receiver !== this.threadId
          )
            this.forThread(receiver).setParentToolId(parent);
        }
      }
    }
  }

  forThread(threadId: string): CodexAppServerTranslator {
    if (threadId === this.threadId) return this.root;
    let child = this.children.get(threadId);
    if (!child) {
      child = this.root.childTranslator();
      this.children.set(threadId, child);
      // Runtime background threads are bounded too. Keep recent history for
      // late correlations without retaining every child of a long-lived chat.
      if (this.children.size > 512) {
        const oldest = this.children.keys().next().value!;
        this.children.delete(oldest);
        this.turns.delete(oldest);
        this.retiredTurns.delete(oldest);
      }
    }
    return child;
  }
}
