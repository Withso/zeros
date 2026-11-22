// Cloud submodules of a project repository (C4). The server is the only place
// a repository's .gitmodules is parsed; builds and workers act on the plan it
// gives them. The rules are Local's (apps/desktop/src/engine/git/submodules.ts):
// only github.com repositories, safe paths and names, a gitlink at exactly the
// path, depth 3 and 32 submodules in all.
//
// One level is remembered as a pure function of a repository at a commit: its
// .gitmodules entries and their gitlink commits, nothing about who may read
// them. The tree is composed per request, and a level is read only after the
// caller's access to that repository is checked.
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../authz.js";

export const SUBMODULE_LIMITS = { maxDepth: 3, maxCount: 32 } as const;
export const MAX_GITMODULES_BYTES = 64 * 1024;
export const MAX_GITMODULES_ENTRIES = 256;

export type GitHubRepository = { owner: string; repo: string };

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function gitHubRepository(owner: string, rawRepo: string): GitHubRepository | null {
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (repo === "." || repo === ".." || repo.endsWith(".git")) return null;
  return { owner, repo };
}

/** Only `https://github.com/<owner>/<repo>` and `git@github.com:<owner>/<repo>` (optional `.git`, optional
 * trailing `/` on https). No userinfo, port, query, fragment, alternate case or other transport. Either form
 * is fetched over HTTPS with a scoped token; an SSH key is never used. */
export function parseGitHubSubmoduleUrl(value: string): GitHubRepository | null {
  if (value.length > 512 || /[\0-\x20\x7f\\]/.test(value)) return null;
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(value);
  if (https) return gitHubRepository(https[1]!, https[2]!);
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(value);
  if (ssh) return gitHubRepository(ssh[1]!, ssh[2]!);
  return null;
}

const isRelativeUrl = (value: string) => value.startsWith("./") || value.startsWith("../");

/** Git resolves `./` and `../` against the parent's remote; the result must again be `<owner>/<repo>`. */
export function resolveRelativeSubmoduleUrl(relative: string, base: GitHubRepository): GitHubRepository | null {
  if (/[\0-\x20\x7f\\]/.test(relative)) return null;
  const segments = [base.owner, base.repo];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!segments.length) return null; segments.pop(); continue; }
    segments.push(part);
  }
  return segments.length === 2 ? gitHubRepository(segments[0]!, segments[1]!) : null;
}

function rejectedUrl(value: string): string {
  if (isRelativeUrl(value)) return "relative URL does not resolve to a github.com repository";
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) return "remote-helper transports are not followed";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol.toLowerCase() === "file:") return "local paths are not followed";
      if (parsed.hostname.toLowerCase() !== "github.com") return "only github.com submodules are followed";
    } catch { /* the generic wording below */ }
    return "only https://github.com/<owner>/<repo> and git@github.com:<owner>/<repo> URLs are followed";
  }
  const scp = /^(?:[^@/:]+@)?([^:/]+):(?!\/)/.exec(value);
  if (scp && scp[1]!.length > 1)
    return scp[1]!.toLowerCase() === "github.com" ? "only https://github.com/<owner>/<repo> and git@github.com:<owner>/<repo> URLs are followed"
      : "only github.com submodules are followed";
  return "local paths are not followed";
}

// Code points HFS+ ignores when comparing names (Git's utf8.c next_hfs_char).
const HFS_IGNORABLE_RE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
/** The comparison key a case-insensitive, normalizing filesystem uses. */
export const foldPathComponent = (component: string) => component.replace(HFS_IGNORABLE_RE, "").normalize("NFC").toLowerCase();

function reservedComponent(component: string): string | null {
  const folded = foldPathComponent(component).replace(/[. ]+$/, "");
  if (folded === ".git" || folded === "git~1") return "a path component names .git";
  if (folded === ".zeros") return "paths under .zeros are reserved for Zeros";
  return null;
}
const hasControl = (value: string) => [...value].some(character => {
  const code = character.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
});

/** Why a repository-relative submodule path is refused, or null. */
export function submodulePathProblem(value: string): string | null {
  if (!value || value.length > 1024) return "path is empty or too long";
  if (hasControl(value) || /[\\:]/.test(value)) return "path contains a control character, backslash or colon";
  if (value.startsWith("/")) return "path is absolute";
  for (const part of value.replace(/\/+$/, "").split("/")) {
    if (part === "" || part === "." || part === "..") return "path leaves the workspace";
    const reserved = reservedComponent(part);
    if (reserved) return reserved;
  }
  return null;
}

/** Git's own rule for submodule names (submodule.c check_submodule_name). */
export function submoduleNameProblem(value: string): string | null {
  if (!value || value.length > 1024) return "name is empty or too long";
  if (hasControl(value)) return "name contains a control character";
  if (value.split(/[/\\]/).some(part => part === "..")) return "name contains ..";
  return null;
}

/** Module Git directories are keyed by a digest, never by the name (CVE-2019-1387). */
export const submoduleGitDirName = (name: string) => createHash("sha256").update(name, "utf8").digest("hex");

/**
 * Git's config syntax, as `git config --blob --list` reads it, for `submodule.<name>.path` and `.url` only.
 * Sections `[name]`, `[name "subsection"]` and the deprecated `[name.subsection]`; quoted values with
 * `\"`, `\\`, `\n`, `\t` and `\b`; a backslash before a newline continues the value; `#` and `;` start a
 * comment outside quotes. Includes are never followed. Null when Git would refuse the file.
 */
export function parseGitmodules(text: string): { name: string; path?: string; url?: string }[] | null {
  const byName = new Map<string, { name: string; path?: string; url?: string }>();
  let section: string | null = null, subsection: string | null = null, i = 0;
  const at = () => text[i];
  const skipBlank = () => { while (i < text.length && (text[i] === " " || text[i] === "\t")) i++; };
  while (i < text.length) {
    skipBlank();
    const c = at();
    if (c === undefined) break;
    if (c === "\n" || c === "\r") { i++; continue; }
    if (c === "#" || c === ";") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "[") {
      i++;
      const start = i;
      while (i < text.length && /[A-Za-z0-9.-]/.test(text[i]!)) i++;
      let name = text.slice(start, i);
      if (!name) return null;
      subsection = null;
      if (text[i] === " " || text[i] === "\t") {
        skipBlank();
        if (text[i] !== "\"") return null;
        i++;
        let value = "";
        for (;;) {
          const d = text[i++];
          if (d === undefined || d === "\n" || d === "\0") return null;
          if (d === "\"") break;
          if (d === "\\") { const e = text[i++]; if (e === undefined || e === "\n") return null; value += e; continue; }
          value += d;
        }
        if (text[i++] !== "]") return null;
        subsection = value;
      } else {
        if (text[i++] !== "]") return null;
        // The deprecated `[section.subsection]` form: a lower-cased subsection.
        const dot = name.indexOf(".");
        if (dot >= 0) { subsection = name.slice(dot + 1).toLowerCase(); name = name.slice(0, dot); if (!subsection) return null; }
      }
      if (name.includes(".")) return null;
      section = name.toLowerCase();
      continue;
    }
    if (!/[A-Za-z]/.test(c)) return null;
    const start = i;
    while (i < text.length && /[A-Za-z0-9-]/.test(text[i]!)) i++;
    const key = text.slice(start, i).toLowerCase();
    skipBlank();
    let value: string | null = null;
    if (text[i] === "=") {
      i++;
      skipBlank();
      let out = "", quoted = false, pendingSpace = "";
      for (;;) {
        const d = text[i];
        if (d === undefined || (d === "\n" && !quoted)) break;
        if (d === "\n" && quoted) return null;
        if (d === "\0") return null;
        i++;
        if (!quoted && (d === "#" || d === ";")) { while (i < text.length && text[i] !== "\n") i++; break; }
        if (d === "\\") {
          const e = text[i++];
          if (e === "\n") continue;
          if (e === "\r" && text[i] === "\n") { i++; continue; }
          const escaped = e === "n" ? "\n" : e === "t" ? "\t" : e === "b" ? "\b" : e === "\\" || e === "\"" ? e : null;
          if (escaped === null) return null;
          out += pendingSpace + escaped; pendingSpace = "";
          continue;
        }
        if (d === "\"") { quoted = !quoted; out += pendingSpace; pendingSpace = ""; continue; }
        if (!quoted && (d === " " || d === "\t" || d === "\r")) { pendingSpace += d === "\r" ? "" : d; continue; }
        out += pendingSpace + d; pendingSpace = "";
      }
      if (quoted) return null;
      value = out;
    } else if (text[i] !== undefined && text[i] !== "\n" && text[i] !== "\r" && text[i] !== "#" && text[i] !== ";") return null;
    if (section === null) return null;
    if (section !== "submodule" || subsection === null || (key !== "path" && key !== "url") || value === null) continue;
    let entry = byName.get(subsection);
    if (!entry) { entry = { name: subsection }; byName.set(subsection, entry); }
    entry[key] = value;
  }
  return [...byName.values()];
}

/** One submodule entry of a repository at a commit: accepted with its gitlink commit, or skipped. */
export type SubmoduleLevelEntry =
  | { name: string; path: string; repository: string; commit: string }
  | { name: string; path?: string; repository?: string; skipped: string };
/** A repository's submodules at one commit. Nothing in it depends on who read it. */
export type SubmoduleLevel = { entries: SubmoduleLevelEntry[]; notice?: string };

const ContentsFile = z.object({ type: z.string(), size: z.number().int().nonnegative(), encoding: z.string().optional(), content: z.string().optional() }).passthrough();
const ContentsSubmodule = z.object({ type: z.string(), sha: z.string().optional(), path: z.string().optional() }).passthrough();
type Http = { json<T>(path: string, schema: z.ZodType<T>): Promise<T> };
const notFound = (error: unknown) => error instanceof HttpError && error.status === 404;
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Reads one level: `.gitmodules` at the commit, then one contents request per accepted path for its gitlink
 * (never a directory walk). At most SUBMODULE_LIMITS.maxCount gitlinks are read; the rest are skipped.
 */
export async function readSubmoduleLevel(http: Http, parent: { repository: string; repositoryId: string }, commit: string): Promise<SubmoduleLevel> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error("Invalid commit");
  const [owner, repo] = parent.repository.split("/") as [string, string];
  const base = gitHubRepository(owner, repo);
  let file;
  try { file = await http.json(`/repositories/${parent.repositoryId}/contents/.gitmodules?ref=${commit}`, ContentsFile); }
  catch (error) { if (notFound(error)) return { entries: [] }; throw error; }
  if (file.type !== "file" || file.encoding !== "base64" || file.content === undefined) return { entries: [], notice: ".gitmodules is not a regular file" };
  if (file.size > MAX_GITMODULES_BYTES) return { entries: [], notice: ".gitmodules is too large" };
  const parsed = parseGitmodules(Buffer.from(file.content.replace(/\s+/g, ""), "base64").toString("utf8"));
  if (parsed === null) return { entries: [], notice: ".gitmodules could not be parsed" };
  if (parsed.length > MAX_GITMODULES_ENTRIES) return { entries: [], notice: ".gitmodules declares too many submodules" };
  const entries: SubmoduleLevelEntry[] = [], seen = new Set<string>();
  let read = 0;
  for (const entry of parsed) {
    const skip = (skipped: string, extra: { path?: string; repository?: string } = {}) => { entries.push({ name: entry.name, ...extra, skipped }); };
    const nameProblem = submoduleNameProblem(entry.name);
    if (nameProblem) { skip(nameProblem); continue; }
    if (entry.path === undefined) { skip("no path in .gitmodules"); continue; }
    const path = entry.path.replace(/\/+$/, "");
    const pathProblem = submodulePathProblem(path);
    if (pathProblem) { skip(pathProblem); continue; }
    const folded = path.split("/").map(foldPathComponent).join("/");
    if (seen.has(folded)) { skip("another submodule already uses this path", { path }); continue; }
    seen.add(folded);
    if (entry.url === undefined) { skip("no url in .gitmodules", { path }); continue; }
    const github = isRelativeUrl(entry.url) ? base && resolveRelativeSubmoduleUrl(entry.url, base) : parseGitHubSubmoduleUrl(entry.url);
    if (!github) { skip(rejectedUrl(entry.url), { path }); continue; }
    const repository = `${github.owner}/${github.repo}`.toLowerCase();
    if (read >= SUBMODULE_LIMITS.maxCount) { skip(`more than ${SUBMODULE_LIMITS.maxCount} submodules`, { path, repository }); continue; }
    read++;
    let gitlink;
    try { gitlink = await http.json(`/repositories/${parent.repositoryId}/contents/${encodePath(path)}?ref=${commit}`, ContentsSubmodule); }
    catch (error) { if (notFound(error)) { skip("no submodule commit is recorded at this path", { path, repository }); continue; } throw error; }
    if (gitlink.type !== "submodule" || (gitlink.path !== undefined && gitlink.path !== path)) { skip("no submodule commit is recorded at this path", { path, repository }); continue; }
    if (!gitlink.sha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(gitlink.sha)) { skip("recorded commit is malformed", { path, repository }); continue; }
    entries.push({ name: entry.name, path, repository, commit: gitlink.sha });
  }
  return { entries };
}

/** A submodule in a composed plan; `path` and `gitDir` are relative to the top checkout and its `.git`. */
export type SubmodulePlanEntry = { path: string; name: string; repository: string; repositoryId: string; commit: string; depth: number; gitDir: string };
export type SubmoduleSkip = { path: string; repository?: string; reason: string };
export type SubmodulePlan = { submodules: SubmodulePlanEntry[]; skipped: SubmoduleSkip[]; notices: string[] };

/**
 * Composes the tree for one caller: `access` answers a submodule repository's id only when the caller (or
 * the build's token) may read it, and a level is read only after that. Depth 3 and 32 accepted in all.
 */
export async function composeSubmodulePlan(input: {
  root: { repository: string; repositoryId: string; commit: string };
  level(repository: { repository: string; repositoryId: string }, commit: string): Promise<SubmoduleLevel>;
  access(repository: string): Promise<string | null>;
}): Promise<SubmodulePlan> {
  const plan: SubmodulePlan = { submodules: [], skipped: [], notices: [] };
  const queue = [{ repository: input.root.repository, repositoryId: input.root.repositoryId, commit: input.root.commit, prefix: "", gitDir: "", depth: 1 }];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    const level = await input.level(current, current.commit);
    if (level.notice) plan.notices.push(`${level.notice}${current.prefix ? ` in ${current.prefix}` : ""}; its submodules were skipped`);
    for (const entry of level.entries) {
      const path = entry.path === undefined ? undefined : current.prefix ? `${current.prefix}/${entry.path}` : entry.path;
      const skip = (reason: string) => { plan.skipped.push({ path: path ?? entry.name, ...(entry.repository ? { repository: entry.repository } : {}), reason }); };
      if ("skipped" in entry) { skip(entry.skipped); continue; }
      const folded = path!.split("/").map(foldPathComponent).join("/");
      if (seen.has(folded)) { skip("another submodule already uses this path"); continue; }
      seen.add(folded);
      if (current.depth > SUBMODULE_LIMITS.maxDepth) { skip(`nested deeper than ${SUBMODULE_LIMITS.maxDepth} levels`); continue; }
      if (plan.submodules.length >= SUBMODULE_LIMITS.maxCount) { skip(`more than ${SUBMODULE_LIMITS.maxCount} submodules`); continue; }
      const repositoryId = await input.access(entry.repository);
      if (!repositoryId) { skip("no access"); continue; }
      const gitDir = `${current.gitDir ? `${current.gitDir}/` : ""}modules/${submoduleGitDirName(entry.name)}`;
      plan.submodules.push({ path: path!, name: entry.name, repository: entry.repository, repositoryId, commit: entry.commit, depth: current.depth, gitDir });
      if (current.depth < SUBMODULE_LIMITS.maxDepth)
        queue.push({ repository: entry.repository, repositoryId, commit: entry.commit, prefix: path!, gitDir, depth: current.depth + 1 });
    }
  }
  return plan;
}
