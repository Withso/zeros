import type { CodexAppServerTranslator } from "./app-server-translator";

export class CodexThreadNotifications {
  private readonly children = new Map<string, CodexAppServerTranslator>();
  private readonly parents = new Map<string, CodexAppServerTranslator>();
  private readonly completedChildren = new Map<string, string>();
  private readonly turns = new Map<string, string>();
  private readonly retiredTurns = new Map<string, Set<string>>();
  private rootReview: {
    turnId?: string;
    pending: Array<{ method: string; params: unknown; turnId: string }>;
    bytes: number;
    overflowed: boolean;
  } | undefined;
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

  /** A local prompt owns a new translator/model-selection epoch before input
   * preparation can await I/O. Retire the old native turn at that boundary,
   * including delayed control events before the new turn/started arrives. */
  startRootTurn(options: { review?: boolean } = {}): void {
    this.endRootReview();
    const previous = this.turns.get(this.threadId);
    if (previous) this.retireTurn(this.threadId, previous);
    this.root.startTurn();
    if (options.review) {
      this.rootReview = { pending: [], bytes: 0, overflowed: false };
    }
  }

  /** Inline review can emit an internal turn/started ID that differs from
   * review/start's ID on its items and completion. Only the acknowledgement
   * binds this explicit review; early frames wait for that authority. */
  bindRootReviewTurn(turnId: string): void {
    const review = this.rootReview;
    if (!review) return;
    if (review.overflowed || this.retiredTurns.get(this.threadId)?.has(turnId)) {
      this.retireTurn(this.threadId, turnId);
      throw new Error("Codex review notifications could not be correlated.");
    }
    review.turnId = turnId;
    this.turns.set(this.threadId, turnId);
    const pending = review.pending.splice(0);
    review.bytes = 0;
    for (const event of pending) this.handle(event.method, event.params);
  }

  endRootReview(): void {
    if (!this.rootReview) return;
    // A rejected/cancelled request with no acknowledgement must not leave
    // its buffered native IDs eligible to become a later prompt's turn.
    for (const event of this.rootReview.pending) {
      this.retireTurn(this.threadId, event.turnId);
    }
    this.rootReview = undefined;
  }

  handle(method: string, params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      turn?: {
        id?: string;
        status?: string;
        itemsView?: string;
        items?: Array<{
          id?: string;
          type?: string;
          tool?: string;
          receiverThreadIds?: string[];
          agentThreadId?: string;
        }>;
      };
      thread?: { id?: string };
      item?: {
        id?: string;
        type?: string;
        tool?: string;
        receiverThreadIds?: string[];
        agentThreadId?: string;
      };
    } | null;
    const threadId =
      p?.threadId ??
      (method === "thread/started" ? p?.thread?.id : undefined) ??
      this.threadId;
    const translator = this.forThread(threadId);
    const turnId = p?.turnId ?? p?.turn?.id;
    if (turnId && this.retiredTurns.get(threadId)?.has(turnId)) return;
    if (threadId === this.threadId && turnId && this.rootReview) {
      const review = this.rootReview;
      if (!review.turnId) {
        if (!review.overflowed) {
          review.bytes += Buffer.byteLength(JSON.stringify(params));
          // Match the native bridge's byte bound, with a separate event cap.
          // Overflow fails at acknowledgement, never as an empty success.
          if (review.pending.length >= 512 || review.bytes > 8 * 1024 * 1024) {
            review.overflowed = true;
          } else {
            review.pending.push({ method, params, turnId });
          }
        }
        return;
      }
      if (turnId !== review.turnId) {
        this.retireTurn(threadId, turnId);
        return;
      }
    }
    if (method === "turn/started" && turnId) {
      const previous = this.turns.get(threadId);
      if (previous && previous !== turnId) this.retireTurn(threadId, previous);
      // User prompts already reset the root before turn/start. Native parent
      // continuations have no adapter prompt call, so retire their prior
      // terminal state here just as we do for child turns.
      if (
        previous !== turnId &&
        (threadId !== this.threadId || translator.sawTurnTerminal)
      )
        translator.startTurn();
      this.turns.set(threadId, turnId);
      this.completedChildren.delete(threadId);
    }
    // Item ids can be reused in the next turn. After a local prompt begins or
    // a native continuation starts, stale frames cannot mutate its records or
    // control state. Earlier late bookkeeping stays with its original turn.
    if (
      turnId &&
      this.turns.has(threadId) &&
      this.turns.get(threadId) !== turnId
    )
      return;
    translator.handle(method, params);
    if (
      threadId !== this.threadId &&
      method === "turn/completed" &&
      p?.turn?.status &&
      ["completed", "interrupted", "failed"].includes(p.turn.status)
    ) {
      this.completedChildren.set(threadId, p.turn.status);
      this.parents.get(threadId)?.completeAgentThread(threadId, p.turn.status);
    }
    const items = p?.item
      ? [p.item]
      : method === "turn/completed" &&
          p?.turn?.itemsView === "full" &&
          Array.isArray(p.turn.items)
        ? p.turn.items
        : [];
    for (const item of items) {
      if (
        item.type === "subAgentActivity" &&
        item.id &&
        item.agentThreadId &&
        item.agentThreadId !== threadId &&
        item.agentThreadId !== this.threadId
      ) {
        const parent = translator.toolCallIdFor(item.id);
        if (parent) this.attachChild(item.agentThreadId, parent, translator);
      }
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
              this.attachChild(receiver, parent, translator);
          }
        }
      }
    }
  }

  private retireTurn(threadId: string, turnId: string): void {
    const retired = this.retiredTurns.get(threadId) ?? new Set<string>();
    retired.add(turnId);
    if (retired.size > 128) retired.delete(retired.values().next().value!);
    this.retiredTurns.set(threadId, retired);
  }

  private attachChild(
    threadId: string,
    parentToolId: string,
    owner: CodexAppServerTranslator,
  ): void {
    const child = this.forThread(threadId);
    const firstOwner = !this.parents.has(threadId);
    this.parents.set(threadId, owner);
    child.setParentToolId(parentToolId);
    const completed = this.completedChildren.get(threadId);
    if (firstOwner && completed) owner.completeAgentThread(threadId, completed);
  }

  endAgentActivity(): void {
    this.root.endAgentActivity();
    for (const child of this.children.values()) child.endAgentActivity();
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
        this.parents.delete(oldest);
        this.completedChildren.delete(oldest);
      }
    }
    return child;
  }
}
