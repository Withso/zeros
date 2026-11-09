import type { DesignFrameView } from "./design-frame-view";

/** Everything a passive selection publication tells the engine. */
export interface DesignPassiveSelection {
  readonly workspaceId: string;
  readonly owner: { readonly directoryId?: string | null; readonly pageId?: string | null; readonly revision?: number } | undefined;
  readonly frame: Pick<DesignFrameView, "file" | "sourceVersion" | "title" | "x" | "y" | "width" | "height"> | null;
  readonly selected: boolean;
  readonly event: number | undefined;
}

/** Decides when the canvas's passive selection is worth publishing. A
 * snapshot update that leaves all of it as it was is not a new activation:
 * republishing it cost a Design document mutation for every lazily prepared
 * batch, 64 on a 1,000-frame open. */
export class DesignPassiveSelectionPublisher {
  private published: string | null = null;

  /** True when this selection differs from the last one offered since a forget. */
  offer(selection: DesignPassiveSelection): boolean {
    const frame = selection.frame;
    const key = JSON.stringify([selection.workspaceId, selection.owner?.directoryId ?? null, selection.owner?.pageId ?? null,
      selection.owner?.revision ?? null, frame?.file ?? null, frame?.sourceVersion ?? null, frame?.title ?? null,
      frame?.x ?? null, frame?.y ?? null, frame?.width ?? null, frame?.height ?? null, selection.selected, selection.event ?? null]);
    if (key === this.published) return false;
    this.published = key;
    return true;
  }

  /** The engine keeps selection in memory only: after a reconnect or an
   * engine respawn, the next offer publishes again. */
  forget(): void {
    this.published = null;
  }
}
