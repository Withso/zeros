/** Local databases may import the same WorkOS organization. Their persistent
 * checkout owner separates Boat resources; restarting the API keeps the name. */
function prefix(channel: string, localOwner?: string): string {
  if (localOwner === undefined) return `zeros-${channel}`;
  if (channel !== "development" || !/^[a-f0-9]{24}$/.test(localOwner)) throw new Error("Invalid local cloud resource owner");
  return `zeros-local-${localOwner}`;
}

export function cloudV2SnapshotName(channel: string, organizationId: string, version: number, localOwner?: string): string {
  return `${prefix(channel, localOwner)}-${organizationId.replace(/-/g, "").slice(0, 12)}-v${version}`;
}

export function cloudV2SandboxName(channel: string, kind: "build" | "ws" | "copy", id: string, localOwner?: string): string {
  return `${prefix(channel, localOwner)}-${kind}-${id.slice(0, 8)}`;
}

/** Organizations on Zeros's shared base store it as "<snapshot>@<build>", so
 * each one's computer row stays unique. Boat only ever sees the snapshot. */
export function cloudV2SharedSnapshotReference(snapshot: string, buildId: string): string {
  return `${snapshot}@${buildId}`;
}
export function cloudV2BoatSnapshotName(stored: string): string {
  const at = stored.indexOf("@");
  return at < 0 ? stored : stored.slice(0, at);
}

/** Zeros's shared standard base for one worker runtime: `zeros-<channel>-base-<sha12>`, `-r<n>` for a rebuild of the
 * same runtime, `zeros-local-<owner>-base-<sha12>` in a Local database. "base" is not 12 hex characters, so no
 * organization snapshot (cloudV2SnapshotName) or sandbox name can take this form. */
export function cloudV2SharedBaseName(channel: string, runtimeSha256: string, rebuild = 0, localOwner?: string): string {
  if (!/^[0-9a-f]{64}$/.test(runtimeSha256)) throw new Error("Invalid worker runtime");
  if (!Number.isSafeInteger(rebuild) || rebuild < 0 || rebuild > 999) throw new Error("Invalid shared base rebuild");
  return `${prefix(channel, localOwner)}-base-${runtimeSha256.slice(0, 12)}${rebuild ? `-r${rebuild}` : ""}`;
}

/** The deployment's own prefix for every Boat resource it names, followed by its separator. Inventory lists only
 * names that start with it, so Local databases and other channels on the same Boat account are never counted. */
export function cloudV2ResourcePrefix(channel: string, localOwner?: string): string {
  return `${prefix(channel, localOwner)}-`;
}

const SHARED_BASE = /^zeros-(alpha|production|development|local-[a-f0-9]{24})-base-([0-9a-f]{12})(?:-r([1-9][0-9]{0,2}))?$/;
/** A shared base name's parts, or null for any other name (organization snapshots, sandboxes, other deployments). */
export function parseCloudV2SharedBaseName(name: string): { scope: string; runtime12: string; rebuild: number } | null {
  const match = SHARED_BASE.exec(name);
  return match ? { scope: match[1]!, runtime12: match[2]!, rebuild: match[3] ? Number(match[3]) : 0 } : null;
}
