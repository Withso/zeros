import { AsyncLocalStorage } from "node:async_hooks";

export type GithubWriteCredential = {
  /** Operation proxy capability, never a GitHub user token. */
  token: string;
  apiBaseUrl: string;
  gitBaseUrl: string;
  owner: string;
  repository: string;
  expiresAtMs: number;
};
type Scope = { credential: GithubWriteCredential; live: boolean; authorized(): boolean };
const storage = new AsyncLocalStorage<Scope>();

/** A write belongs to one admitted request. Never replace the engine's shared
 * read credential: other actors and native processes run concurrently. */
export async function runWithGithubWriteCredential<T>(
  credential: GithubWriteCredential,
  authorized: () => boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const scope: Scope = { credential, authorized, live: true };
  try {
    return await storage.run(scope, async () => {
      githubWriteCredential();
      return operation();
    });
  } finally {
    // Async descendants inherit the scope; retaining it cannot extend a grant.
    scope.live = false;
  }
}

export function githubWriteCredential(repository?: { owner: string; repository: string }): GithubWriteCredential | null {
  const scope = storage.getStore();
  if (!scope) return null;
  if (!scope.live || !scope.authorized() || scope.credential.expiresAtMs <= Date.now() ||
      (repository && (repository.owner.toLowerCase() !== scope.credential.owner.toLowerCase() ||
        repository.repository.toLowerCase() !== scope.credential.repository.toLowerCase())))
    throw new Error("GitHub write authorization is no longer valid. Try again.");
  return scope.credential;
}
