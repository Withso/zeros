import { z } from "zod";
import type { Tx } from "./db.js";

const loginSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const authorName = z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f<>]+$/);
const userSchema = z.object({ id: z.number().int().positive().safe(), login: loginSchema, name: z.unknown().optional() });
export type GithubCommitProfile = { login: string; githubUserId: string; gitName: string };
export type GithubGitAuthor = { name: string; email: string };

/** Called only on GitHub's authenticated /user response. Public email, account
 * email and token material are deliberately not part of this projection. */
export function githubCommitProfile(value: unknown): GithubCommitProfile {
  const user = userSchema.parse(value), name = authorName.safeParse(user.name);
  return { login: user.login, githubUserId: String(user.id), gitName: name.success ? name.data : user.login };
}

/** Callers must first authorize the exact workspace actor. An installation's
 * owner or a delegated agent credential's owner is not the commit author. */
export async function readGithubGitAuthor(tx: Tx, actorUserId: string): Promise<GithubGitAuthor | null> {
  const row = (await tx.query<{ github_user_id: string | null; github_login: string; git_author_name: string | null }>(
    "SELECT github_user_id,github_login,git_author_name FROM github_authorizations WHERE owner_user_id=$1 AND app_variant='github.com'",
    [actorUserId],
  )).rows[0];
  if (!row?.github_user_id || !/^[1-9][0-9]{0,15}$/.test(row.github_user_id) || !loginSchema.safeParse(row.github_login).success) return null;
  const name = authorName.safeParse(row.git_author_name);
  return { name: name.success ? name.data : row.github_login, email: `${row.github_user_id}+${row.github_login}@users.noreply.github.com` };
}
