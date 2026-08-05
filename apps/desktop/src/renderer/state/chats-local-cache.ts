// ──────────────────────────────────────────────────────────
// Chat localStorage cache keys — single source of truth
// ──────────────────────────────────────────────────────────
//
// The renderer keeps a localStorage cache of the chat list so the sidebar
// paints on cold boot without an engine round-trip. These keys are shared by
// app-shell's ChatsPersistence (which owns the read/write/recover lifecycle)
// and any code that has to bulk-mutate the cache out-of-band — e.g. removing a
// repository, which deletes that repo's chats and must keep the cache from
// resurrecting them. Defining them once here keeps those two surfaces in lock
// step (a drifted key would silently re-introduce deleted chats on reload).
// ──────────────────────────────────────────────────────────

/** Primary chat list cache. Read at boot; written on every chat mutation. */
export const CHATS_STORAGE_KEY = "chats-v1";

/** Secondary, never-wiped snapshot of the chat list. If the primary key ever
 *  shows up empty (corrupt localStorage, accidental reducer wipe, a dev reload
 *  that races with hydrate, an origin change), the sidebar recovers from this.
 *  Only updated on writes that *have* chats, so a legitimate empty primary
 *  never stomps the backup. */
export const CHATS_BACKUP_KEY = "chats-v1-backup";

/** Tombstone flag — true when the most recent write left the primary list
 *  intentionally empty (user deleted/archived all chats, or removed the last
 *  repo). Tells hydrate "don't second-guess this; do NOT restore from backup
 *  or SQLite". Without it, the safety net resurrects every chat just removed on
 *  the next reload. */
export const CHATS_TOMBSTONE_KEY = "chats-v1-cleared";

/** Persisted active chat id. */
export const ACTIVE_CHAT_KEY = "active-chat-id";
