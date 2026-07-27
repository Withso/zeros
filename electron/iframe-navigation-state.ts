export interface PendingIframeNavigation {
  frameTreeNodeId: number;
  requestedUrl: string;
  targetUrl: string;
  previousUrl: string;
  sequence: number;
}

function canonicalHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Tracks the one provisional navigation currently owned by each logical
 * Browser iframe. React remounts an iframe for explicit navigation, so the
 * stable frame name — not Chromium's per-instance frame-tree id — owns the
 * token. Failure events from an older instance must not roll back a newer one. */
export class PendingIframeNavigations {
  private readonly byFrameName = new Map<string, PendingIframeNavigation>();
  private readonly activeFrameIds = new Map<string, number>();
  private sequence = 0;

  begin(
    frameName: string,
    frameTreeNodeId: number,
    targetUrl: string,
    previousUrl: string,
  ): PendingIframeNavigation | null {
    const canonicalTarget = canonicalHttpUrl(targetUrl);
    if (!canonicalTarget) return null;
    const pending = {
      frameTreeNodeId,
      requestedUrl: canonicalTarget,
      targetUrl: canonicalTarget,
      previousUrl: canonicalHttpUrl(previousUrl) ?? "",
      sequence: ++this.sequence,
    };
    this.activeFrameIds.set(frameName, frameTreeNodeId);
    this.byFrameName.set(frameName, pending);
    return pending;
  }

  current(frameName: string): PendingIframeNavigation | null {
    return this.byFrameName.get(frameName) ?? null;
  }

  /** Move an in-flight token to a server redirect destination without losing
   * the last committed URL that a terminal cancellation must restore. */
  redirect(
    frameName: string,
    frameTreeNodeId: number,
    targetUrl: string,
  ): PendingIframeNavigation | null {
    const current = this.byFrameName.get(frameName);
    const canonicalTarget = canonicalHttpUrl(targetUrl);
    if (
      !current ||
      current.frameTreeNodeId !== frameTreeNodeId ||
      !canonicalTarget
    )
      return null;
    const pending = {
      ...current,
      targetUrl: canonicalTarget,
      sequence: ++this.sequence,
    };
    this.byFrameName.set(frameName, pending);
    return pending;
  }

  /** Accept events for an unobserved/active frame, but reject a detached frame
   * after a newer React iframe instance has taken over the same logical tab. */
  isCurrentFrame(frameName: string, frameTreeNodeId: number): boolean {
    const activeFrameId = this.activeFrameIds.get(frameName);
    return activeFrameId == null || activeFrameId === frameTreeNodeId;
  }

  matchesFailure(
    frameName: string,
    frameTreeNodeId: number,
    failedUrl: string,
  ): PendingIframeNavigation | null {
    const pending = this.current(frameName);
    if (!pending || pending.frameTreeNodeId !== frameTreeNodeId) return null;
    return canonicalHttpUrl(failedUrl) === pending.targetUrl ? pending : null;
  }

  complete(frameName: string, expected?: PendingIframeNavigation): boolean {
    const current = this.byFrameName.get(frameName);
    if (!current || (expected && current !== expected)) return false;
    this.byFrameName.delete(frameName);
    return true;
  }

  /** Mark a completed frame as active and consume only its own pending token.
   * A same-instance completion for an older URL can arrive after a rapid
   * replacement navigation has already installed its token. */
  completeFrame(
    frameName: string,
    frameTreeNodeId: number,
    committedUrl: string,
  ): boolean {
    const activeFrameId = this.activeFrameIds.get(frameName);
    if (activeFrameId != null && activeFrameId !== frameTreeNodeId)
      return false;
    this.activeFrameIds.set(frameName, frameTreeNodeId);
    const current = this.byFrameName.get(frameName);
    if (current?.frameTreeNodeId === frameTreeNodeId) {
      if (canonicalHttpUrl(committedUrl) !== current.targetUrl) return false;
      this.byFrameName.delete(frameName);
    }
    return true;
  }

  clear(): void {
    this.byFrameName.clear();
    this.activeFrameIds.clear();
  }
}
