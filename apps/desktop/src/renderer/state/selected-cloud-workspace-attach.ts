import type { CloudWorkspaceDocument } from "../platform/cloud-workspace-contract";
import { canReadCloudWorkspace } from "./cloud-workspace-catalog";

interface Sources {
  document(): CloudWorkspaceDocument | undefined;
  hidden(): boolean;
  warmHistory(): Promise<void>;
  /** Keep a running workspace attached; free when its peer is already connected. */
  connect(): Promise<void>;
  subscribe(listener: () => void): () => void;
  onVisibility(listener: () => void): () => void;
  connected(): void;
  failed(error: unknown): void;
}

/** What the selected workspace's history is served from: a change here is the only catalog notify that reads again. */
function servingState(doc: CloudWorkspaceDocument): string {
  const running = ["ready", "busy"].includes(doc.status);
  return JSON.stringify([running ? "running" : doc.status, doc.generation?.number ?? null, doc.sharing?.readOnly === true]);
}

/** Keep the selected cloud workspace attached without waking it. Its history is read once per serving state and on a
 * return to the visible window; the catalog's other notifications (list refreshes, other workspaces) read nothing. */
export function attachSelectedCloudWorkspace(sources: Sources): () => void {
  let cancelled = false, attaching = false, served: string | undefined;
  const attach = (returned = false) => {
    if (cancelled || sources.hidden()) return;
    const doc = sources.document();
    if (!doc || !canReadCloudWorkspace(doc)) { served = undefined; return; }
    const state = servingState(doc);
    if (returned || state !== served) {
      served = state;
      // A failed read proves nothing: the next notify tries again.
      void sources.warmHistory().catch(() => { if (served === state) served = undefined; });
    }
    if (attaching || !["ready", "busy"].includes(doc.status)) return;
    attaching = true;
    void sources.connect()
      .then(() => { if (!cancelled) sources.connected(); })
      .catch(error => { if (!cancelled) sources.failed(error); })
      .finally(() => { attaching = false; });
  };
  attach();
  const off = sources.subscribe(() => attach());
  const offVisibility = sources.onVisibility(() => attach(true));
  return () => { cancelled = true; off(); offVisibility(); };
}
