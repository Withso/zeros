// Cloud retention (S3) in plain words, in one place: the rule General states once, and the line each archived
// cloud workspace carries. The person gets no email (owner decision, 2026-11-22): this is where they learn it.
import type { CloudWorkspaceRetention } from "../../platform/cloud-workspace-contract";

/** The server's numbers (pinned to its source by test): archived after this many days with no activity... */
export const CLOUD_RETENTION_INACTIVE_DAYS = 30;
/** ...its machine gone within about this many days of the archive (its one 10-day wake, then Boat's 14)... */
export const CLOUD_RETENTION_MACHINE_DAYS = 24;
/** ...and its backup deleted this many days after it. */
export const CLOUD_RETENTION_BACKUP_DAYS = 60;

/** The rule, for General (organization and Personal), shown only where the server runs retention. Every
 * clause is about an archived workspace or about Keep: an open or stopped one loses nothing. */
export const CLOUD_RETENTION_RULE_LABELS: readonly string[] = [`After ${CLOUD_RETENTION_INACTIVE_DAYS} days without use`, "Once archived", "Keep"];
export const CLOUD_RETENTION_RULE: readonly string[] = [
  `A cloud workspace nobody uses for ${CLOUD_RETENTION_INACTIVE_DAYS} days is archived. Unarchiving it brings it back.`,
  `After a workspace is archived, its machine is removed within about ${CLOUD_RETENTION_MACHINE_DAYS} days and its backup after ${CLOUD_RETENTION_BACKUP_DAYS} days. `
    + "Until the backup is removed, unarchiving the workspace restores everything. After that, it is rebuilt from GitHub, and work that was never pushed is gone.",
  "Keep a workspace from its menu so it is never archived for inactivity.",
];

const REASON: Record<NonNullable<CloudWorkspaceRetention["archiveReason"]>, string> = {
  inactive: `Archived after ${CLOUD_RETENTION_INACTIVE_DAYS} days without activity.`,
  member_left: "Archived when its creator left the organization.",
  manual: "Archived.",
};

const day = (at: string, locale?: string) => new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });

/**
 * An archived cloud workspace's line: why, what unarchiving it brings back, and what goes when. Each part only when
 * the server says it (an older server sends less, and says less). Null for a workspace that is not archived or
 * from a server without retention.
 */
export function cloudArchiveLine(retention: CloudWorkspaceRetention | undefined, archived: boolean, now: number, locale?: string): string | null {
  if (!retention || !archived) return null;
  const parts: string[] = [];
  if (retention.archiveReason) parts.push(REASON[retention.archiveReason]);
  if (retention.restores === "all") parts.push("Unarchiving it restores everything.");
  else if (retention.restores === "pushed") parts.push("Unarchiving it rebuilds it from GitHub. Work that was never pushed is gone.");
  const machine = retention.machineExpectedGoneAt;
  if (machine) parts.push(Date.parse(machine.at) <= now ? `Its machine was removed on ${day(machine.at, locale)}.`
    : `Its machine is removed ${machine.estimate ? "around" : "on"} ${day(machine.at, locale)}.`);
  // Only while it still has one: a removal date says what that date means.
  if (retention.backupRemovalAt && retention.restores !== "pushed")
    parts.push(`Backup kept until ${day(retention.backupRemovalAt, locale)}. After that, only what was pushed to GitHub can be restored.`);
  return parts.length ? parts.join(" ") : null;
}
