import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CloudV2ControlFrame } from "@zeros/protocol/cloud-v2-relay";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";

const execute = promisify(execFile);
type GitIdentity = Extract<CloudV2ControlFrame, { t: "config" }>["gitIdentity"];
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** The worker-owned global identity include, relative to the home directory. */
export const GIT_IDENTITY_FILE = join(".config", "zeros", "git-identity");

/** First line of the managed Creator identity (creator-commit-identity-v1): a clean boot keeps it (it is the rule, not
 * a previous person's leftover), and replaces any other identity. */
export const CREATOR_IDENTITY_MARKER = "# zeros: the workspace Creator's commit identity (managed)";

export async function configureGitIdentity(home: string, identity: GitIdentity, mode: { managed?: boolean } = {}): Promise<void> {
  if (identity === undefined) return;
  const file = join(home, GIT_IDENTITY_FILE), temporary = `${file}.${randomUUID()}`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // A global include updates existing shells while preserving deliberate
  // repository-local identities, including those restored from checkpoints.
  const contents = `${mode.managed && identity ? `${CREATOR_IDENTITY_MARKER}\n` : ""}[user]\n\tuseConfigOnly = true\n\tname = ${quote(identity?.name ?? "")}\n\temail = ${quote(identity?.email ?? "")}\n`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  const args = ["config", "--file", join(home, ".gitconfig")], options = { env: workerChildEnvironment(), timeout: 5000 };
  const existing = await execute("git", [...args, "--get-all", "include.path"], options).then(result => result.stdout.split("\n"),
    (error: { code?: number }): string[] => { if (error.code === 1) return []; throw error; });
  if (!existing.includes(file)) await execute("git", [...args, "--add", "include.path", file], options);
}
