import { DESIGN_CAPTURE_TEMP_BYTES } from "@zeros/protocol/design-capture";

/** Main owns one reservation across native exports and renderer captures.
 * No queued HTML or timer can release a lease. Its owner supplies terminal
 * cleanup proof, or main observes that the owning WebContents was destroyed. */
export class DesignCaptureAdmission {
  private active: { owner: object; id: string } | null = null;
  private explicitUntil = 0;

  reserve(owner: object, id: string, explicit = true): boolean {
    if (this.active) {
      // Native exports retry at most once per second. Give an awaiting export
      // first refusal without retaining its source or an unbounded queue.
      if (explicit) this.explicitUntil = Date.now() + 1_100;
      return false;
    }
    if (!explicit && Date.now() < this.explicitUntil) return false;
    this.active = { owner, id };
    if (explicit) this.explicitUntil = 0;
    return true;
  }

  release(owner: object, id: string): boolean {
    if (this.active?.owner !== owner || this.active.id !== id) return false;
    this.active = null;
    return true;
  }

  retireOwner(owner: object): void {
    if (this.active?.owner === owner) this.active = null;
  }

  usage() {
    return { running: this.active ? 1 : 0, reservedBytes: this.active ? DESIGN_CAPTURE_TEMP_BYTES : 0 };
  }
}
