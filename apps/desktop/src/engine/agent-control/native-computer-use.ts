import type { AgentControlFamily } from "@zeros/protocol/browser-tools";
import type { ComputerUseOwner } from "@zeros/protocol/computer-use-tools";

interface NativeOwner {
  owner: ComputerUseOwner;
  agent: AgentControlFamily;
}

/** Forward a provider's built-in computer use to main, so other chats wait
 * for it. Reports for one chat go out in order, and the chat that started is
 * remembered by execution: the execution's routing may already be gone when
 * its last turn settles. */
export class NativeComputerUseReports {
  private readonly active = new Map<string, NativeOwner>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly send: (
      owner: ComputerUseOwner,
      agent: AgentControlFamily,
      active: boolean,
    ) => Promise<unknown>,
  ) {}

  /** `resolve` names the chat when the execution starts acting; null skips
   * an execution that has no Local workspace conversation. */
  update(
    executionId: string,
    active: boolean,
    resolve: () => NativeOwner | null,
  ): Promise<void> {
    let entry = this.active.get(executionId);
    if (active) {
      entry ??= resolve() ?? undefined;
      if (!entry) return Promise.resolve();
      this.active.set(executionId, entry);
    } else {
      if (!entry) return Promise.resolve();
      this.active.delete(executionId);
    }
    return this.enqueue(entry, active);
  }

  private enqueue(entry: NativeOwner, active: boolean): Promise<void> {
    const key = `${entry.owner.workspaceId}\u0000${entry.owner.conversationId}`;
    const tail = (this.tails.get(key) ?? Promise.resolve())
      .then(() => this.send(entry.owner, entry.agent, active))
      .then(
        () => undefined,
        () => undefined,
      );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return tail;
  }
}
