import { chmodSync, closeSync, constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { githubRemoteIdentity, prepareGithubRemoteIdentities, projectForRoot, saveGithubRemoteIdentities, type GithubRemoteIdentity } from "../db/projects";
import { resolveRepoGit } from "../settings/repo-git";
import { GitError } from "./errors";
import { assertSafeGitRef, runFile } from "./git-exec";
import { canonicalGithubRepository, githubRepositorySelection, parseGitHubRemote } from "./github";
import { withWorkspaceGitMutation } from "./mutation-lock";

function readConfig(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Unsupported Git config");
    return { data: readFileSync(fd, "utf8"), ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs, mode: stat.mode };
  } finally { closeSync(fd); }
}

function sameConfig(a: ReturnType<typeof readConfig>, b: ReturnType<typeof readConfig>): boolean {
  return a.data === b.data && a.ino === b.ino && a.dev === b.dev && a.mtimeMs === b.mtimeMs;
}

/** Keep transport, username, SSH port, suffix and remote name. Never touch an
 * alias host, credential-bearing URL, query string or unrelated fork URL. */
function canonicalUrl(url: string, repository: { owner: string; repo: string }): string | null {
  try { parseGitHubRemote(url); } catch { return null; }
  if (!/^[A-Za-z0-9_.-]+$/.test(repository.owner) || !/^[A-Za-z0-9_.-]+$/.test(repository.repo) ||
      [repository.owner, repository.repo].some(part => part === "." || part === "..")) return null;
  const scp = url.includes("://") ? null : /^(?:[^@/:\s]+@)?[^:/\s]+:/.exec(url);
  const suffix = /\.git\/?$/i.test(url) ? ".git" : "";
  const slash = url.endsWith("/") ? "/" : "";
  if (scp) return `${scp[0]}${repository.owner}/${repository.repo}${suffix}${slash}`;
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) return null;
  // Preserve the original authority text too (including an explicit SSH port).
  const prefix = /^[a-z]+:\/\/[^/]+\//i.exec(url);
  return prefix ? `${prefix[0]}${repository.owner}/${repository.repo}${suffix}${slash}` : null;
}

function sameRepository(a: { owner: string; repo: string }, b: { owner: string; repo: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

async function effectiveRemoteMatches(repoRoot: string, remote: string, url: string, pushUrls: string[]): Promise<boolean> {
  const effective = (await runFile("git", ["-C", repoRoot, "remote", "get-url", "--all", remote])).stdout.trim();
  if (effective !== url) return false;
  const push = (await runFile("git", ["-C", repoRoot, "remote", "get-url", "--push", "--all", remote])).stdout.trim().split("\n");
  return push.length === pushUrls.length && push.every((value, i) => value === pushUrls[i]);
}

/** An explicit background mutation, separate from PR reads. Network work is
 * outside the Git mutation lane; the final commit owns Git's config.lock and
 * checks the exact config, registration, selected connection and remote again.
 * A crash after the rename is repaired from the checkout on the next refresh. */
export async function reconcileGithubRepository(repoRoot: string) {
  const owner = projectForRoot(repoRoot);
  if (!owner) return { project: null, changed: false };
  const selectedRemote = resolveRepoGit(owner.repoRoot).remote;
  assertSafeGitRef(selectedRemote, "repository remote");
  const common = (await runFile("git", ["-C", owner.repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const file = path.join(common, "config");
  const observed = readConfig(file);
  // Parse these exact bytes with Git, not an INI parser or a second path read.
  const parsed = await runFile("git", ["config", "--file", "-", "--no-includes", "--null", "--list"], { input: observed.data });
  const values = new Map<string, string[]>();
  for (const entry of parsed.stdout.split("\0")) {
    const split = entry.indexOf("\n");
    if (split < 0) continue;
    const key = entry.slice(0, split);
    values.set(key, [...(values.get(key) ?? []), entry.slice(split + 1)]);
  }
  const candidates: { remote: string; url: string; target: { owner: string; repo: string } }[] = [];
  for (const remote of new Set(["origin", selectedRemote])) {
    const urls = values.get(`remote.${remote}.url`);
    if (urls?.length !== 1) continue; // inherited and multi-fetch setups stay intact
    let target: { owner: string; repo: string };
    try { target = parseGitHubRemote(urls[0]); } catch { continue; }
    if (!canonicalUrl(urls[0], target)) continue;
    const configuredPush = values.get(`remote.${remote}.pushurl`) ?? urls;
    if (!await effectiveRemoteMatches(owner.repoRoot, remote, urls[0], configuredPush)) continue;
    candidates.push({ remote, url: urls[0], target });
  }
  if (!candidates.length) return { project: owner, changed: false };
  const stillSelected = await githubRepositorySelection();
  const identities: GithubRemoteIdentity[] = [];
  const pendingIdentities: GithubRemoteIdentity[] = [];
  const edits: { key: string; before: string; after: string }[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const candidate of candidates) {
    const previous = githubRemoteIdentity(owner.repoRoot, candidate.remote, candidate.url);
    const canonical = await canonicalGithubRepository(candidate.target, previous);
    const url = canonicalUrl(candidate.url, canonical);
    if (!url || !Number.isSafeInteger(canonical.id) || canonical.id < 1 || !canonical.nodeId) {
      throw new GitError({ code: "VALIDATION_FAILED", message: "GitHub returned an invalid repository identity." });
    }
    const identity = { remote: candidate.remote, url, repositoryId: String(canonical.id), nodeId: canonical.nodeId,
      owner: canonical.owner, repo: canonical.repo };
    identities.push(identity);
    const pendingUrls = [...new Set([...(previous?.pendingUrls ?? []), candidate.url])];
    pendingIdentities.push({ ...identity, pendingUrls });
    for (const source of pendingUrls) {
      const from = parseGitHubRemote(source);
      moves.push({ from: `${from.owner}/${from.repo}`, to: `${canonical.owner}/${canonical.repo}` });
    }
    if (url !== candidate.url) edits.push({ key: `remote.${candidate.remote}.url`, before: candidate.url, after: url });
    for (const pushUrl of values.get(`remote.${candidate.remote}.pushurl`) ?? []) {
      let pushTarget: { owner: string; repo: string };
      try { pushTarget = parseGitHubRemote(pushUrl); } catch { continue; }
      if (!sameRepository(pushTarget, candidate.target)) continue;
      const after = canonicalUrl(pushUrl, canonical);
      if (after && after !== pushUrl) edits.push({ key: `remote.${candidate.remote}.pushurl`, before: pushUrl, after });
    }
  }
  return withWorkspaceGitMutation(owner.repoRoot, async () => {
    const currentOwner = () => {
      const current = projectForRoot(owner.repoRoot);
      return current?.canonicalId === owner.canonicalId && current.originRevision === owner.originRevision &&
        resolveRepoGit(owner.repoRoot).remote === selectedRemote;
    };
    const unchanged = () => currentOwner() && sameConfig(readConfig(file), observed);
    if (!unchanged() || !await stillSelected()) return { project: projectForRoot(owner.repoRoot), changed: false };
    const originUrl = identities.find(identity => identity.remote === "origin")?.url ?? owner.originUrl;
    let locked = false;
    const lock = `${file}.lock`;
    try {
      if (edits.length) {
        const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        locked = true;
        try { writeFileSync(fd, observed.data); } finally { closeSync(fd); }
        for (const key of new Set(edits.map(edit => edit.key))) {
          await runFile("git", ["config", "--file", lock, "--no-includes", "--unset-all", key]);
          for (const before of values.get(key) ?? []) {
            const after = edits.find(edit => edit.key === key && edit.before === before)?.after ?? before;
            await runFile("git", ["config", "--file", lock, "--no-includes", "--add", key, after]);
          }
        }
        chmodSync(lock, observed.mode & 0o777);
      }
      // Includes and global URL rewrites can change without touching config.
      // Recheck Git's effective fetch/push destinations after the API work.
      for (const candidate of candidates) {
        const pushUrls = values.get(`remote.${candidate.remote}.pushurl`) ?? [candidate.url];
        if (!await effectiveRemoteMatches(owner.repoRoot, candidate.remote, candidate.url, pushUrls))
          return { project: projectForRoot(owner.repoRoot), changed: false };
      }
      if (!await stillSelected() || !unchanged()) return { project: projectForRoot(owner.repoRoot), changed: false };
      // No await between the last fences, durable move record, atomic rename
      // and native commit. Retain every source if an earlier attempt failed.
      if (locked) {
        if (!prepareGithubRemoteIdentities(owner, pendingIdentities)) return { project: projectForRoot(owner.repoRoot), changed: false };
        renameSync(lock, file); locked = false;
      }
      const project = saveGithubRemoteIdentities(owner, identities, originUrl, moves);
      return { project, changed: edits.length > 0 || originUrl !== owner.originUrl || moves.some(move => move.from !== move.to) };
    } catch {
      throw new GitError({ code: "GIT_COMMAND_FAILED", message: "Could not update the repository remote. It will be checked again on refresh." });
    } finally {
      if (locked) { try { unlinkSync(lock); } catch { /* Preserve the original failure. */ } }
    }
  });
}
