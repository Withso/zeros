import { createHash } from "node:crypto";

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

export function cloudV2SandboxName(channel: string, kind: "build" | "ws", id: string, localOwner?: string): string {
  return `${prefix(channel, localOwner)}-${kind}-${id.slice(0, 8)}`;
}
/** Distinct for each completed stop; even the longest local prefix fits Boat's
 * 63-character limit. A retry keeps the same persisted name. */
export function cloudV2RetentionSnapshotName(channel: string, workspaceId: string, stoppedAt: string, localOwner?: string): string {
  const generation = createHash("sha256").update(`${workspaceId}:${stoppedAt}`).digest("hex").slice(0, 20);
  return `${prefix(channel, localOwner)}-ret-${generation}`;
}
