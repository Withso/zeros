/**
 * A gesture's latest live preview, kept until the gesture commits or restores
 * so a document that replaces the previewed one (an undo finishing, another
 * edit landing) can show it too. A generation counts as showing the preview
 * only once the preview reached it; a failed attempt is offered again.
 */
export class DesignGesturePreview<Request> {
  private request: Request | null = null;
  private shownOn: string | null = null;
  private tryingOn: string | null = null;

  /** A preview asked for at `generation`; null while no document is current. */
  ask(request: Request, generation: string | null): void {
    this.request = request;
    this.shownOn = null;
    this.tryingOn = generation;
  }

  shown(request: Request, generation: string): void {
    if (this.request !== request) return;
    this.shownOn = generation;
    this.tryingOn = null;
  }

  failed(request: Request): void {
    if (this.request === request) this.tryingOn = null;
  }

  /** The preview to show again on `generation`, if it is not there or on its way. */
  replay(generation: string | null): Request | null {
    if (this.request === null || !generation) return null;
    if (this.shownOn === generation || this.tryingOn === generation) return null;
    return this.request;
  }

  clear(): void {
    this.request = null;
    this.shownOn = null;
    this.tryingOn = null;
  }
}
