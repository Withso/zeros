import {
  collectAttachmentSourceIds,
  isAttachmentSourceId,
} from "@zeros/protocol/attachment-policy";

const owners = new Set<() => unknown>();
const CLIPBOARD_KEY = "zeros:attachment-clipboard-sources:v1";

/** A mounted editor includes its undo side store, not only its visible pills.
 * Transfers and parked drafts register independently, so one completion or
 * unmount cannot release another owner's recovery source. */
export function registerAttachmentSourceOwner(read: () => unknown): () => void {
  owners.add(read);
  return () => {
    owners.delete(read);
  };
}

export function retainedAttachmentSourceIds(
  additional?: unknown,
): string[] | null {
  try {
    return collectAttachmentSourceIds([
      additional,
      ...[...owners].map((read) => read()),
    ]);
  } catch {
    return null;
  }
}

export function rememberAttachmentClipboardSources(payload: unknown): void {
  const ids = collectAttachmentSourceIds(payload);
  if (!ids) return;
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(ids));
  } catch {
    /* Native clipboard remains authoritative. */
  }
}

/** Browser-only harnesses cannot read the OS clipboard without permission.
 * Keep the last app copy conservatively; Electron supplies the actual current
 * clipboard ids, including its HTML fallback, on every cleanup. */
export function rememberedAttachmentClipboardSources(): string[] {
  if (typeof localStorage === "undefined") return [];
  const ids: unknown = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? "[]");
  if (
    !Array.isArray(ids) ||
    ids.length > 100_000 ||
    !ids.every(isAttachmentSourceId)
  )
    throw new Error("Attachment clipboard recovery metadata is unavailable");
  return ids;
}
