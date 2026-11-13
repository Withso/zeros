import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { CloudV2GitIdentitySchema } from "@zeros/protocol/cloud-v2-relay";

type CloudV2GitIdentity = z.infer<typeof CloudV2GitIdentitySchema>;
type Source = "creator" | "actor";
const CONTEXT_ID = /^[0-9a-f-]{36}$/i;
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** A context's person as Git author and committer; no identity sets none (Git then refuses rather than borrowing anyone's). */
export const gitIdentityEnvironment = (identity: CloudV2GitIdentity | null): Record<string, string> => identity
  ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {};

/** Review comments are the person's own (rule 5): the lease's personName, or on an N−1 control plane its person's identity. */
export function reviewRequesterName(lease: { personName?: string; gitIdentity: CloudV2GitIdentity | null }, source: Source | undefined): string | undefined {
  return lease.personName ?? (source ? undefined : lease.gitIdentity?.name);
}

/** GIT_CONFIG_COUNT (Git ≥ 2.31) is what lets an open process follow a later identity change. */
function gitSupportsConfigEnvironment(): boolean {
  try {
    const [major = 0, minor = 0] = (/git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5000 }))?.slice(1) ?? []).map(Number);
    return major > 2 || major === 2 && minor >= 31;
  } catch { return false; }
}

/**
 * Creator commit identity (creator-commit-identity-v1, owner decision 2026-11-13): in an activated workspace every commit
 * is authored as the CURRENT Creator, whose identity is the VM-wide managed include; with no Creator, each context commits
 * as its own person. A context's processes never pin GIT_AUTHOR_*: they point Git at their own small include file
 * (~/.zeros/contexts/<id>/git-identity), empty while a Creator applies and the actor's [user] otherwise, rewritten on every
 * change, so an open terminal or turn commits as whoever the rule names at that moment. An N−1 control plane (no source)
 * keeps today's per-person env; Git older than 2.31 pins the identity when the context opens (until it is reopened).
 */
export class ContextCommitIdentities {
  private source: Source | undefined;
  private creator: CloudV2GitIdentity | null = null;
  private readonly live = new Map<string, CloudV2GitIdentity | null>();
  private readonly configEnv: boolean;

  constructor(private readonly home: string, options: { configEnv?: boolean } = {}) {
    this.configEnv = options.configEnv ?? gitSupportsConfigEnvironment();
  }

  /** The control plane's current rule; rewrites every open context's file when it changes. */
  configure(source: Source | undefined, creator: CloudV2GitIdentity | null): void {
    this.source = source; this.creator = creator;
    if (source && this.configEnv) for (const [contextId, actor] of this.live) this.write(contextId, actor);
  }

  get identitySource(): Source | undefined { return this.source; }

  environment(contextId: string, actor: CloudV2GitIdentity | null): Record<string, string> {
    if (!this.source) return gitIdentityEnvironment(actor);
    if (!this.configEnv) return gitIdentityEnvironment(this.source === "creator" ? this.creator : actor);
    this.live.set(contextId, actor);
    return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "include.path", GIT_CONFIG_VALUE_0: this.write(contextId, actor) };
  }

  /** When the context ends (its directory is erased with it). */
  forget(contextId: string): void {
    if (!this.live.delete(contextId) || !CONTEXT_ID.test(contextId)) return;
    rmSync(this.file(contextId), { force: true });
  }

  private file(contextId: string): string {
    if (!CONTEXT_ID.test(contextId)) throw new Error("Invalid execution context.");
    return join(this.home, ".zeros", "contexts", contextId, "git-identity");
  }

  private write(contextId: string, actor: CloudV2GitIdentity | null): string {
    const file = this.file(contextId), directory = join(file, "..");
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    // Empty: the VM-wide managed include (the Creator's, or none and Git refuses). Never the actor while a Creator applies.
    const contents = this.source === "actor" && actor ? `[user]\n\tname = ${quote(actor.name)}\n\temail = ${quote(actor.email)}\n` : "";
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, contents, { mode: 0o600 }); renameSync(temporary, file);
    return file;
  }
}
