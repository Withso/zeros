import type { GithubAuthSnapshot } from "@zeros/protocol/github-auth";
import type { CloudGithubLevelConnections } from "../../platform/cloud-github-levels";
import { ghAuthSnapshot } from "../../platform/git";
import { useNativeRuntime } from "../../platform/runtime";
import { ghAuthStatusCache, GITHUB_READ_MAX_AGE_MS } from "../../state/read-caches";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { githubAuthSnapshotKey } from "./github-auth-prefetch";

/** The account the Mac's selected GitHub method signs in as, or the first configured one. */
export function githubIdentitySummary(snapshot: GithubAuthSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  const selected = snapshot.methods[snapshot.selectedMethod];
  const login = (selected.configured ? selected.login : undefined)
    ?? Object.values(snapshot.methods).find(method => method.configured && method.login)?.login;
  return login ? `Connected as @${login}` : "Not connected";
}

/** Same keyed read as the GitHub page, so opening it reuses this snapshot. */
export function GithubIdentityHint({ accountId }: { accountId: string | undefined }) {
  const connected = useNativeRuntime().ready;
  const read = useRecoveringRead(ghAuthStatusCache, githubAuthSnapshotKey(accountId),
    () => ghAuthSnapshot(accountId ? { userId: accountId } : undefined), { maxAgeMs: GITHUB_READ_MAX_AGE_MS, connected });
  return <>{githubIdentitySummary(read.data) ?? null}</>;
}

export function connectionCount(connections: CloudGithubLevelConnections): string {
  const count = connections.organization.length + connections.personal.filter(row => row.mine).length;
  return count === 0 ? "No connections yet" : count === 1 ? "1 connection" : `${count} connections`;
}
