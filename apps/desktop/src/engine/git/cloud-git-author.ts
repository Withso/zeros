import { AsyncLocalStorage } from "node:async_hooks";
import { CloudGitAuthorSchema, type CloudGitAuthor } from "@zeros/protocol/cloud-agent-execution";

type Scope = { author: CloudGitAuthor; live: boolean; authorized(): boolean };
const storage = new AsyncLocalStorage<Scope>();
const unavailable = () => new Error("Connect or refresh your GitHub account before creating cloud Git commits.");

/** Never write an actor's identity into shared repository/global Git config.
 * Empty defaults stop an unconnected native process borrowing another member's
 * configuration. Existing processes retain their starting identity. */
export function cloudGitAuthorEnvironment(value: CloudGitAuthor | null): Record<string, string> {
  const author = value === null ? null : CloudGitAuthorSchema.parse(value);
  return { GIT_AUTHOR_NAME: author?.name ?? "", GIT_AUTHOR_EMAIL: author?.email ?? "",
    GIT_COMMITTER_NAME: author?.name ?? "", GIT_COMMITTER_EMAIL: author?.email ?? "" };
}

export async function runWithCloudGitAuthor<T>(value: CloudGitAuthor | null, authorized: () => boolean, operation: () => Promise<T>): Promise<T> {
  if (!value) throw unavailable();
  const scope: Scope = { author: Object.freeze(CloudGitAuthorSchema.parse(value)), live: true, authorized };
  try {
    return await storage.run(scope, async () => { scopedCloudGitAuthorEnvironment(); return operation(); });
  } finally { scope.live = false; }
}

export function scopedCloudGitAuthorEnvironment(): Record<string, string> {
  const scope = storage.getStore();
  if (!scope) return {};
  if (!scope.live || !scope.authorized()) throw unavailable();
  return cloudGitAuthorEnvironment(scope.author);
}

/** These managed operations can create commit/tag objects, including stashes
 * and Design commits. Other reads and edits do not require a GitHub identity. */
const AUTHOR_OPERATIONS = new Set(["git.commit", "git.pull", "git.rebase", "git.merge", "git.cherryPick", "git.revert",
  "git.continue", "git.stashSave", "git.tagCreate", "design.commit"]);
export function needsCloudGitAuthor(op: string, params: Record<string, unknown> = {}): boolean {
  return AUTHOR_OPERATIONS.has(op) || (op === "git.changeTarget" && params.rebase === true);
}
