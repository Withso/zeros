export interface CloudSendOwner {
  account: number;
  folder: string;
  generation: number | undefined;
  cancellation: number;
  stopVersion?: number;
  lifecyclePending?: boolean;
}

function sameOwner(a: CloudSendOwner, b: CloudSendOwner | undefined): boolean {
  return !!b && a.account === b.account && a.folder === b.folder &&
    (a.generation === undefined || b.generation !== undefined && (b.generation >= a.generation || b.lifecyclePending === true)) &&
    a.cancellation === b.cancellation && a.stopVersion === b.stopVersion;
}

/** Preparation has no prompt payload or submission retry. The caller retains
 * its draft until this exact chat can use fresh workspace admission. */
export class CloudSendPreparation {
  private readonly flights = new Map<string, {
    owner: CloudSendOwner;
    controller: AbortController;
    task: Promise<void>;
    off?: () => void;
  }>();

  prepare(
    chatId: string,
    owner: CloudSendOwner,
    open: (signal: AbortSignal) => Promise<void>,
    current: () => CloudSendOwner | undefined,
    observe?: (listener: () => void) => () => void,
  ): Promise<void> {
    const existing = this.flights.get(chatId);
    if (existing && sameOwner(existing.owner, owner)) { existing.owner.generation = owner.generation; return existing.task; }
    this.cancel(chatId);
    owner = { ...owner };
    const controller = new AbortController();
    const assertCurrent = () => {
      if (controller.signal.aborted) throw new Error("Message preparation cancelled");
      const next = current();
      if (!sameOwner(owner, next)) throw new Error("Cloud message owner changed before submission");
      owner.generation = next?.generation;
    };
    // Publish the cancellation owner before opening the bridge can notify any
    // subscribers. A same-turn Stop must prevent compute acquisition entirely.
    const task = Promise.resolve().then(async () => {
      assertCurrent();
      await open(controller.signal);
      assertCurrent();
    }).finally(() => {
      off?.();
      if (this.flights.get(chatId)?.task === task) this.flights.delete(chatId);
    });
    // Observe rollback while it is waking; readiness may resolve after the
    // source is already ready. The bridge still fences each exact admission.
    const off = observe?.(() => { try { assertCurrent(); } catch { controller.abort(); } });
    this.flights.set(chatId, { owner, controller, task, off });
    return task;
  }

  has(chatId: string): boolean { return this.flights.has(chatId); }

  cancel(chatId: string): void {
    const pending = this.flights.get(chatId);
    this.flights.delete(chatId);
    pending?.off?.();
    pending?.controller.abort();
  }

  clear(): void {
    for (const chatId of this.flights.keys()) this.cancel(chatId);
  }
}
