// One-shot submodule fetch for a freshly created Local workspace.
//
// Ordinary engine Git refuses every recursive submodule option and forces
// `submodule.recurse=false` (git-exec.ts). This module does not relax that.
// `git submodule` would follow repository-controlled URLs and `update = !cmd`,
// and its child clones would escape runGit's per-target credential scoping, so
// it is never run. Instead each submodule is one ordinary, policy-hardened
// `runGit` clone of an approved github.com URL, followed by a detached checkout
// of the pinned commit.
//
// Nothing here writes `submodule.*` config, so later Git commands behave exactly
// as before. `.gitmodules` is read as data from the committed blob; only `path`
// and `url` are read, and `update`, `fetchRecurseSubmodules`, `branch` and
// every other key is ignored.

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { resolveRepoGit } from "../settings/repo-git";
import { GitError } from "./errors";
import { classifyGitTransportError, runGit } from "./git-exec";
import { getWorkspaceById } from "./state";

export interface SubmoduleLimits {
  /** Top-level submodules are depth 1. */
  maxDepth: number;
  /** Submodules attempted across every depth. */
  maxCount: number;
  cloneTimeoutMs: number;
  totalBudgetMs: number;
}

export const SUBMODULE_LIMITS: Readonly<SubmoduleLimits> = {
  maxDepth: 3,
  maxCount: 32,
  cloneTimeoutMs: 180_000,
  totalBudgetMs: 15 * 60_000,
};

const MAX_GITMODULES_BYTES = 64 * 1024;
const MAX_GITMODULES_ENTRIES = 256;

export type SubmoduleOutcomeStatus = "fetched" | "skipped" | "failed";

export interface SubmoduleOutcome {
  /** Workspace-relative path, `/`-separated. */
  path: string;
  name: string;
  status: SubmoduleOutcomeStatus;
  /** github.com owner/repo for an accepted URL; never the raw URL. */
  repository?: string;
  reason?: string;
}

export interface FetchSubmodulesResult {
  outcomes: SubmoduleOutcome[];
  /** The `.gitmodules` file itself could not be used. */
  notice?: string;
}

/** Test-only clone source. The shipped entry point never passes one. */
export interface SubmoduleCloneSource {
  (repository: GitHubRepository): string;
}

export interface FetchSubmodulesOptions {
  workspacePath: string;
  /** Superproject remote whose URL resolves relative submodule URLs. */
  remote: string;
  signal?: AbortSignal;
  limits?: Partial<SubmoduleLimits>;
  cloneSource?: SubmoduleCloneSource;
}

export interface GitHubRepository {
  form: "https" | "ssh";
  owner: string;
  repo: string;
  /** The approved URL, exactly as it will be cloned in production. */
  url: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function gitHubRepository(
  form: "https" | "ssh",
  owner: string,
  rawRepo: string,
): GitHubRepository | null {
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (repo === "." || repo === ".." || repo.endsWith(".git")) return null;
  const url =
    form === "https"
      ? `https://github.com/${owner}/${repo}.git`
      : `git@github.com:${owner}/${repo}.git`;
  return { form, owner, repo, url };
}

/** Only `https://github.com/<owner>/<repo>` and `git@github.com:<owner>/<repo>`
 * (optional `.git`, optional trailing `/` on https). No userinfo, port, query,
 * fragment, alternate case, or other transport. */
export function parseGitHubSubmoduleUrl(value: string): GitHubRepository | null {
  if (value.length > 512 || /[\0-\x20\x7f\\]/.test(value)) return null;
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(value);
  if (https) return gitHubRepository("https", https[1]!, https[2]!);
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(value);
  if (ssh) return gitHubRepository("ssh", ssh[1]!, ssh[2]!);
  return null;
}

function isRelativeUrl(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

/** Git resolves `./` and `../` against the superproject's remote URL. Only a
 * github.com base can produce an approved result, and the result must again be
 * exactly `<owner>/<repo>` on github.com. */
export function resolveRelativeSubmoduleUrl(
  relative: string,
  base: GitHubRepository | null,
): GitHubRepository | null {
  if (!base || /[\0-\x20\x7f\\]/.test(relative)) return null;
  const segments = [base.owner, base.repo];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length !== 2) return null;
  return gitHubRepository(base.form, segments[0]!, segments[1]!);
}

const PLAIN_GITHUB_ONLY =
  "only https://github.com/<owner>/<repo> and git@github.com:<owner>/<repo> URLs are followed";

function describeRejectedUrl(value: string): string {
  if (isRelativeUrl(value)) {
    return "relative URL does not resolve to a github.com repository";
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) {
    return "remote-helper transports are not followed";
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol.toLowerCase() === "file:") return "local paths are not followed";
      if (parsed.hostname.toLowerCase() !== "github.com") {
        return "only github.com submodules are followed";
      }
    } catch {
      /* falls through to the generic github.com wording */
    }
    return PLAIN_GITHUB_ONLY;
  }
  const scp = /^(?:[^@/:]+@)?([^:/]+):(?!\/)/.exec(value);
  if (scp && scp[1]!.length > 1) {
    return scp[1]!.toLowerCase() === "github.com"
      ? PLAIN_GITHUB_ONLY
      : "only github.com submodules are followed";
  }
  return "local paths are not followed";
}

// Code points HFS+ ignores when comparing names (Git's utf8.c next_hfs_char).
const HFS_IGNORABLE_RE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/** The comparison key a case-insensitive, normalizing filesystem uses. */
export function foldPathComponent(component: string): string {
  return component.replace(HFS_IGNORABLE_RE, "").normalize("NFC").toLowerCase();
}

/** A component Git, HFS+ or NTFS could treat as `.git`, or Zeros' own folder. */
function reservedComponent(component: string): string | null {
  const folded = foldPathComponent(component).replace(/[. ]+$/, "");
  if (folded === ".git" || folded === "git~1") return "a path component names .git";
  if (folded === ".zeros") return "paths under .zeros are reserved for Zeros";
  return null;
}

function isControlCodePoint(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (isControlCodePoint(character.codePointAt(0)!)) return true;
  }
  return false;
}

/** Returns why a repository-relative submodule path is refused, or null. */
export function submodulePathProblem(value: string): string | null {
  if (!value || value.length > 1024) return "path is empty or too long";
  if (hasControlCharacter(value) || /[\\:]/.test(value)) {
    return "path contains a control character, backslash or colon";
  }
  if (value.startsWith("/")) return "path is absolute";
  const parts = value.replace(/\/+$/, "").split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return "path leaves the workspace";
    const reserved = reservedComponent(part);
    if (reserved) return reserved;
  }
  return null;
}

/** Git's own rule for submodule names (submodule.c check_submodule_name). */
export function submoduleNameProblem(value: string): string | null {
  if (!value || value.length > 1024) return "name is empty or too long";
  if (hasControlCharacter(value)) return "name contains a control character";
  if (value.split(/[/\\]/).some((part) => part === "..")) return "name contains ..";
  return null;
}

/** Module Git directories are keyed by a digest, never by the name: names are
 * repository-controlled, and on a case-insensitive filesystem two names can
 * collide or one can nest inside another's Git directory (CVE-2019-1387). */
export function submoduleGitDirName(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex");
}

interface GitmodulesEntry {
  name: string;
  path?: string;
  url?: string;
}

function parseConfigList(stdout: string): GitmodulesEntry[] {
  const byName = new Map<string, GitmodulesEntry>();
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? "" : record.slice(newline + 1);
    if (!key.toLowerCase().startsWith("submodule.")) continue;
    const lastDot = key.lastIndexOf(".");
    if (lastDot <= "submodule.".length) continue;
    const name = key.slice("submodule.".length, lastDot);
    const variable = key.slice(lastDot + 1).toLowerCase();
    if (variable !== "path" && variable !== "url") continue;
    let entry = byName.get(name);
    if (!entry) {
      entry = { name };
      byName.set(name, entry);
    }
    entry[variable] = value;
  }
  return [...byName.values()];
}

interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

function parseLsTree(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(" ");
    if (!mode || !type || !object) continue;
    entries.push({ mode, type, object, path: record.slice(tab + 1) });
  }
  return entries;
}

async function lsTree(cwd: string, args: string[], signal?: AbortSignal): Promise<TreeEntry[]> {
  const { stdout } = await runGit(
    cwd,
    ["ls-tree", "-z", "--full-tree", "HEAD", ...args],
    { readOnly: true, signal, timeoutMs: 30_000 },
  );
  return parseLsTree(stdout);
}

async function readGitmodules(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ entries: GitmodulesEntry[]; notice?: string }> {
  const [file] = await lsTree(cwd, ["--", ".gitmodules"], signal);
  if (!file) return { entries: [] };
  if (file.mode !== "100644" || file.type !== "blob") {
    return { entries: [], notice: ".gitmodules is not a regular file" };
  }
  const size = Number(
    (
      await runGit(cwd, ["cat-file", "-s", file.object], {
        readOnly: true,
        signal,
      })
    ).stdout.trim(),
  );
  if (!Number.isFinite(size) || size > MAX_GITMODULES_BYTES) {
    return { entries: [], notice: ".gitmodules is too large" };
  }
  // `--blob` reads the committed bytes as data; includes are not followed.
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      cwd,
      ["config", "--blob", file.object, "--null", "--list"],
      { readOnly: true, signal, timeoutMs: 10_000 },
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    return { entries: [], notice: ".gitmodules could not be parsed" };
  }
  const entries = parseConfigList(stdout);
  if (entries.length > MAX_GITMODULES_ENTRIES) {
    return { entries: [], notice: ".gitmodules declares too many submodules" };
  }
  return { entries };
}

async function remoteRepository(cwd: string, remote: string): Promise<GitHubRepository | null> {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(remote)) return null;
  try {
    const { stdout } = await runGit(cwd, ["remote", "get-url", remote], {
      readOnly: true,
      timeoutMs: 5_000,
    });
    return parseGitHubSubmoduleUrl(stdout.trim());
  } catch {
    return null;
  }
}

/** Refuse a component that a case-insensitive filesystem would merge with a
 * different tracked entry in the same directory. */
async function caseCollision(
  repoCwd: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const directory = parts.slice(0, index).join("/");
    const siblings = await lsTree(
      repoCwd,
      directory ? ["--", `${directory}/`] : [],
      signal,
    );
    const component = parts[index]!;
    const folded = foldPathComponent(component);
    for (const sibling of siblings) {
      const name = sibling.path.slice(directory ? directory.length + 1 : 0);
      if (name !== component && foldPathComponent(name) === folded) {
        return "path collides with another tracked path that differs only by case";
      }
    }
  }
  return null;
}

/** Every component below `root` must be a real directory (never a symlink),
 * and the gitlink folder itself must be empty. */
async function targetProblem(root: string, relativePath: string): Promise<string | null> {
  let current = root;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      return "folder is not checked out in this workspace (sparse checkout or removed)";
    }
    if (stats.isSymbolicLink()) return "a symlink is in the path";
    if (!stats.isDirectory()) return "path is not a folder in this workspace";
  }
  const physical = await realpath(current);
  const relative = path.relative(root, physical);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return "path leaves the workspace";
  }
  if ((await readdir(current)).length > 0) return "folder is not empty";
  return null;
}

async function emptyFolder(folder: string): Promise<void> {
  for (const child of await readdir(folder).catch(() => [] as string[])) {
    await rm(path.join(folder, child), { recursive: true, force: true });
  }
}

function transportErrorCode(stderr: string) {
  return classifyGitTransportError(stderr) ?? "GIT_COMMAND_FAILED";
}

function failureReason(error: unknown): string {
  const cause = error instanceof GitError ? (error.cause as { signal?: unknown } | undefined) : undefined;
  if (cause?.signal) return "timed out";
  const code = error instanceof GitError ? error.code : null;
  if (code === "NOT_AUTHENTICATED") {
    return "GitHub refused access (a private repository the connected account cannot read, or it does not exist)";
  }
  if (code === "NETWORK_ERROR") return "couldn't reach github.com";
  if (code === "VALIDATION_FAILED") return "the engine refused the Git operation";
  return "git clone or checkout failed";
}

interface Repository {
  /** Physical working-tree root of this repository. */
  cwd: string;
  /** Workspace-relative prefix (`""` for the superproject). */
  prefix: string;
  gitDir: string;
  depth: number;
  base: GitHubRepository | null;
}

export async function fetchSubmodules(
  opts: FetchSubmodulesOptions,
): Promise<FetchSubmodulesResult> {
  const limits = { ...SUBMODULE_LIMITS, ...opts.limits };
  const deadline = Date.now() + limits.totalBudgetMs;
  const outcomes: SubmoduleOutcome[] = [];
  const workspaceRoot = await realpath(opts.workspacePath);
  const gitDir = (
    await runGit(workspaceRoot, ["rev-parse", "--absolute-git-dir"], {
      readOnly: true,
    })
  ).stdout.trim();
  const queue: Repository[] = [
    {
      cwd: workspaceRoot,
      prefix: "",
      gitDir,
      depth: 1,
      base: await remoteRepository(workspaceRoot, opts.remote),
    },
  ];
  let attempted = 0;
  const notices: string[] = [];
  const seenPaths = new Set<string>();

  while (queue.length > 0) {
    const repository = queue.shift()!;
    if (opts.signal?.aborted) break;
    const gitmodules = await readGitmodules(repository.cwd, opts.signal);
    if (gitmodules.notice) {
      const where = repository.prefix ? ` in ${repository.prefix}` : "";
      notices.push(`${gitmodules.notice}${where}; its submodules were skipped`);
    }
    for (const entry of gitmodules.entries) {
      const relative = (entry.path ?? "").replace(/\/+$/, "");
      const displayPath = repository.prefix
        ? `${repository.prefix}/${relative}`
        : relative;
      const skip = (reason: string, repositoryName?: string) =>
        outcomes.push({
          path: displayPath,
          name: entry.name,
          status: "skipped",
          reason,
          ...(repositoryName ? { repository: repositoryName } : {}),
        });

      const nameProblem = submoduleNameProblem(entry.name);
      if (nameProblem) { skip(nameProblem); continue; }
      const pathProblem =
        entry.path === undefined
          ? "no path in .gitmodules"
          : submodulePathProblem(relative) ??
            submodulePathProblem(displayPath);
      if (pathProblem) { skip(pathProblem); continue; }
      const foldedDisplay = displayPath.split("/").map(foldPathComponent).join("/");
      if (seenPaths.has(foldedDisplay)) { skip("another submodule already uses this path"); continue; }
      seenPaths.add(foldedDisplay);

      if (entry.url === undefined) { skip("no url in .gitmodules"); continue; }
      const github = isRelativeUrl(entry.url)
        ? resolveRelativeSubmoduleUrl(entry.url, repository.base)
        : parseGitHubSubmoduleUrl(entry.url);
      if (!github) { skip(describeRejectedUrl(entry.url)); continue; }
      const repositoryName = `github.com/${github.owner}/${github.repo}`;

      if (repository.depth > limits.maxDepth) {
        skip(`nested deeper than ${limits.maxDepth} levels`, repositoryName);
        continue;
      }
      if (attempted >= limits.maxCount) {
        skip(`more than ${limits.maxCount} submodules`, repositoryName);
        continue;
      }
      if (Date.now() >= deadline) {
        skip("the submodule time budget ran out", repositoryName);
        continue;
      }
      if (opts.signal?.aborted) break;

      const [gitlink] = await lsTree(repository.cwd, ["--", relative], opts.signal);
      if (!gitlink || gitlink.mode !== "160000" || gitlink.path !== relative) {
        skip("no submodule commit is recorded at this path", repositoryName);
        continue;
      }
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(gitlink.object)) {
        skip("recorded commit is malformed", repositoryName);
        continue;
      }
      const collision = await caseCollision(repository.cwd, relative, opts.signal);
      if (collision) { skip(collision, repositoryName); continue; }
      const target = path.join(repository.cwd, ...relative.split("/"));
      const targetIssue = await targetProblem(workspaceRoot, path.relative(workspaceRoot, target).split(path.sep).join("/"));
      if (targetIssue) { skip(targetIssue, repositoryName); continue; }
      const modulesDir = path.join(repository.gitDir, "modules");
      const modulesStats = await lstat(modulesDir).catch(() => null);
      if (modulesStats && (modulesStats.isSymbolicLink() || !modulesStats.isDirectory())) {
        skip("the workspace's Git modules folder is not a plain folder", repositoryName);
        continue;
      }
      const moduleGitDir = path.join(modulesDir, submoduleGitDirName(entry.name));
      if (await lstat(moduleGitDir).then(() => true, () => false)) {
        skip("its Git directory already exists", repositoryName);
        continue;
      }

      attempted += 1;
      const stepTimeout = () =>
        Math.max(1_000, Math.min(limits.cloneTimeoutMs, deadline - Date.now()));
      try {
        await mkdir(modulesDir, { recursive: true });
        const source = opts.cloneSource ? opts.cloneSource(github) : github.url;
        await runGit(
          repository.cwd,
          [
            "clone",
            "--no-checkout",
            "--quiet",
            `--separate-git-dir=${moduleGitDir}`,
            "--",
            source,
            target,
          ],
          { timeoutMs: stepTimeout(), signal: opts.signal, mapErrorCode: transportErrorCode },
        );
        const commit = gitlink.object;
        const present = await runGit(
          target,
          ["cat-file", "-e", `${commit}^{commit}`],
          { readOnly: true, signal: opts.signal },
        ).then(() => true, () => false);
        if (!present) {
          await runGit(target, ["fetch", "--quiet", "origin", commit], {
            timeoutMs: stepTimeout(),
            signal: opts.signal,
            mapErrorCode: transportErrorCode,
          });
        }
        await runGit(target, ["checkout", "--quiet", "--detach", commit], {
          signal: opts.signal,
          timeoutMs: stepTimeout(),
        });
        outcomes.push({ path: displayPath, name: entry.name, status: "fetched", repository: repositoryName });
        queue.push({
          cwd: target,
          prefix: displayPath,
          gitDir: moduleGitDir,
          depth: repository.depth + 1,
          base: github,
        });
      } catch (error) {
        await rm(moduleGitDir, { recursive: true, force: true }).catch(() => {});
        await emptyFolder(target);
        outcomes.push({
          path: displayPath,
          name: entry.name,
          status: "failed",
          repository: repositoryName,
          reason: opts.signal?.aborted ? "stopped because the workspace is closing" : failureReason(error),
        });
      }
    }
  }
  return { outcomes, ...(notices.length > 0 ? { notice: notices.join("; ") } : {}) };
}

/** Repository-controlled text reaches an xterm: drop control sequences. */
function printable(value: string): string {
  let cleaned = "";
  for (const character of value) {
    cleaned += isControlCodePoint(character.codePointAt(0)!) ? "?" : character;
  }
  return cleaned.length > 200 ? `${cleaned.slice(0, 199)}…` : cleaned;
}

/** One Setup-log message naming every submodule that was skipped or failed. */
export function formatSubmoduleReport(result: FetchSubmodulesResult): string | null {
  if (result.outcomes.length === 0 && !result.notice) return null;
  const count = (status: SubmoduleOutcomeStatus) =>
    result.outcomes.filter((outcome) => outcome.status === status).length;
  const fetched = count("fetched");
  const skipped = count("skipped");
  const failed = count("failed");
  const lines = [
    `Submodules: ${fetched} fetched, ${skipped} skipped, ${failed} failed.`,
  ];
  if (result.notice) lines.push(`  ${printable(result.notice)}`);
  for (const outcome of result.outcomes) {
    if (outcome.status === "fetched") continue;
    const label = outcome.status === "failed" ? "failed" : "skipped";
    const repository = outcome.repository ? ` (${outcome.repository})` : "";
    lines.push(
      `  ${label}: ${printable(outcome.path || outcome.name)}${repository}: ${printable(outcome.reason ?? "")}`,
    );
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** The shipped post-create step. Local placements with `git.fetch_submodules`
 * only; it never throws, so a failure cannot fail or roll back the create. */
export async function fetchCreatedWorkspaceSubmodules(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace || workspace.placement === "cloud") return null;
  const git = resolveRepoGit(workspace.repoRoot, workspace);
  if (!git.fetchSubmodules) return null;
  try {
    const result = await fetchSubmodules({
      workspacePath: workspace.path,
      remote: git.remote,
      ...(signal ? { signal } : {}),
    });
    return signal?.aborted ? null : formatSubmoduleReport(result);
  } catch (error) {
    if (signal?.aborted) return null;
    console.warn(
      `[submodules] ${workspaceId}: ${error instanceof GitError ? error.code : "failed"}`,
    );
    return "Submodules: not fetched. Zeros couldn't read this workspace's submodule list.\r\n\r\n";
  }
}
