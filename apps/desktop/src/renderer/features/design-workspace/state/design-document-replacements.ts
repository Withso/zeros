export interface DesignDocumentReplacement {
  readonly admitted: boolean;
  readonly cancelled: boolean;
  attach(): () => void;
  cancel(): void;
  prioritize(selected: boolean): void;
}

/** One incoming document at a time across retained Local canvases. Capacity is
 * held through removal/promotion of the actual incoming buffer, not just the
 * parent's cancellation or a successful handshake. */
export class DesignDocumentReplacements {
  private active: DesignDocumentReplacement | null = null;
  private readonly waiting: Array<{ ticket: DesignDocumentReplacement; selected: boolean; admit(): void }> = [];
  private readonly listeners = new Set<() => void>();
  constructor(private readonly maxWaiting = 64) {}

  usage() { return { active: this.active ? 1 : 0, waiting: this.waiting.length }; }

  request(selected: boolean, onAdmit: (ticket: DesignDocumentReplacement) => void): DesignDocumentReplacement | null {
    if (this.active && this.waiting.length >= this.maxWaiting) return null;
    let attachments = 0;
    let releasePending = false;
    const ticket = {
      admitted: false,
      cancelled: false,
      attach: () => {
        if (!ticket.admitted || ticket.cancelled) return () => {};
        attachments++;
        let detached = false;
        return () => {
          if (detached) return;
          detached = true;
          attachments--;
          release();
        };
      },
      cancel: () => {
        ticket.cancelled = true;
        const index = this.waiting.indexOf(entry);
        if (index !== -1) this.waiting.splice(index, 1);
        release();
      },
      prioritize: (selected: boolean) => { entry.selected = selected; },
    };
    const entry = { ticket, selected, admit: () => {
      ticket.admitted = true;
      this.active = ticket;
      onAdmit(ticket);
    } };
    const release = () => {
      if (!ticket.cancelled || attachments || releasePending) return;
      releasePending = true;
      // React's layout cleanup can precede removal of a sibling's host node.
      // Starting another incoming document waits until the commit has ended.
      queueMicrotask(() => {
        releasePending = false;
        if (!ticket.cancelled || attachments) return;
        if (this.active === ticket) this.active = null;
        this.pump();
        for (const listener of [...this.listeners]) listener();
      });
    };
    this.waiting.push(entry);
    this.pump();
    return ticket;
  }

  subscribeAvailable(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private pump() {
    if (this.active || !this.waiting.length) return;
    const selected = this.waiting.findIndex((entry) => entry.selected);
    const [next] = this.waiting.splice(Math.max(0, selected), 1);
    next!.admit();
  }
}

export const designDocumentReplacements = new DesignDocumentReplacements();
