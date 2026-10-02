import { createHash } from "node:crypto";
import { requireCheck, type Channel } from "./contracts";

// Persisted release identities. Keep the admission exports compatible.
export const workerOwner = (channel: Channel) => createHash("sha256").update(`zeros-release-worker:${channel}`).digest("hex").slice(0, 24);
export function workerSnapshotName(state: { owner: string; generation: string }, digest: string) {
  requireCheck(/^[a-f0-9]{24}$/.test(state.owner) && /^[a-f0-9-]{36}$/.test(state.generation) && /^[a-f0-9]{64}$/.test(digest), "Invalid worker slot identity");
  return `dev-${state.owner}-${state.generation.slice(0, 8)}-${digest.slice(0, 16)}`;
}
