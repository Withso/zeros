/** Format closed-chat activity as compact menu metadata. Persisted histories
 * can predate the current schema, so invalid/out-of-range dates degrade to an
 * em dash instead of throwing while the History menu is opening. */
export function formatChatHistoryTime(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";

  const delta = Math.max(0, now - timestamp);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}
