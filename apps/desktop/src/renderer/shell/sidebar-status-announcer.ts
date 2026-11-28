// ============================================
// One polite live region for the sidebar's parent rows. A parent's loader or
// status dot sits inside its child toggle, which is named for the toggle, so
// the row's own markup cannot speak the status; and a row remounts when it
// moves between Status sub-groups, so a per-row region would be new each time
// its status changes. The list keeps one region mounted and announces each
// change by workspace id.
// ============================================

import { useEffect, useRef, useState } from "react";

export interface SidebarStatusAnnouncementRow {
  id: string;
  label: string;
  /** The row's status word, or null when it has none. */
  status: string | null;
}

/** The message for rows whose status changed to a word since `previous`
 *  (null when none did), and the statuses to compare the next pass with. A
 *  row seen for the first time sets its baseline without an announcement. */
export function sidebarStatusAnnouncement(
  previous: ReadonlyMap<string, string | null>,
  rows: readonly SidebarStatusAnnouncementRow[],
): { next: Map<string, string | null>; message: string | null } {
  const next = new Map<string, string | null>();
  const changes: string[] = [];
  for (const row of rows) {
    next.set(row.id, row.status);
    if (!previous.has(row.id) || row.status === null) continue;
    if (previous.get(row.id) !== row.status) changes.push(`${row.label}: ${row.status}`);
  }
  return { next, message: changes.length ? changes.join("; ") : null };
}

/** The region's text for these rows (null while the sidebar is hidden). Each
 *  pass sets it, so a pass with no change clears it and a later change to the
 *  same word is new text the screen reader announces again. Hidden passes
 *  forget the baseline, so rows shown again are first sightings. */
export function useSidebarStatusAnnouncement(rows: readonly SidebarStatusAnnouncementRow[] | null): string | null {
  const seen = useRef(new Map<string, string | null>());
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!rows) {
      seen.current = new Map();
      setMessage(null);
      return;
    }
    const result = sidebarStatusAnnouncement(seen.current, rows);
    seen.current = result.next;
    setMessage(result.message);
  }, [rows]);
  return message;
}
