export interface CloudSendOwner {
  account: number;
  folder: string;
  generation: number | undefined;
  cancellation: number;
}

function sameOwner(a: CloudSendOwner, b: CloudSendOwner | undefined): boolean {
  return !!b && a.account === b.account && a.folder === b.folder &&
    a.generation === b.generation && a.cancellation === b.cancellation;
}

/** Preparation has no prompt payload or submission retry. The caller retains
 * its draft until this exact chat can use fresh workspace admission. */
export class CloudSendPreparation {
  private readonly flights = new Map<string, {
    owner: CloudSendOwner;
    controller: AbortController;
    task: Promise<void>;
  }>();

  prepare(
    chatId: string,
    owner: CloudSendOwner,
    open: (signal: AbortSignal) => Promise<void>,
    current: () => CloudSendOwner | undefined,
  ): Promise<void> {
    const existing = this.flights.get(chatId);
    if (existing && sameOwner(owner, existing.owner)) return existing.task;
    this.cancel(chatId);
    const controller = new AbortController();
    const assertCurrent = () => {
      if (controller.signal.aborted) throw new Error("Message preparation cancelled");
      if (!sameOwner(owner, current())) throw new Error("Cloud message owner changed before submission");
    };
    // Publish the cancellation owner before opening the bridge can notify any
    // subscribers. A same-turn Stop must prevent compute acquisition entirely.
    const task = Promise.resolve().then(async () => {
      assertCurrent();
      await open(controller.signal);
      assertCurrent();
    }).finally(() => {
      if (this.flights.get(chatId)?.task === task) this.flights.delete(chatId);
    });
    this.flights.set(chatId, { owner, controller, task });
    return task;
  }

  has(chatId: string): boolean { return this.flights.has(chatId); }

  cancel(chatId: string): void {
    const pending = this.flights.get(chatId);
    this.flights.delete(chatId);
    pending?.controller.abort();
  }

  clear(): void {
    for (const chatId of this.flights.keys()) this.cancel(chatId);
  }
}
