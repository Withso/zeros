// ──────────────────────────────────────────────────────────
// Design directory resolution — settings pointer + on-disk recognition
// ──────────────────────────────────────────────────────────
//
// Two independent facts meet here:
//
//   1. THE POINTER — `[design] directory` in the settings layers (committed
//      team default < per-machine repo-local < per-worktree pin). Absent
//      means "Zeros Design".
//   2. RECOGNITION — a design folder is repo content, recognizable by its
//      `.zeros-canvas.json` marker in either HEAD or the current index
//      (initializeDesignDocument writes it; create/enter force-add it even
//      through a .gitignore). Taking both snapshots keeps both sides of a
//      staged move protected. The canvas file deliberately contains no
//      repo-specific identity, which is what makes design folders portable
//      between repos once added to Git.
//
// resolveDesignDirectoryForEnter() reconciles them when a workspace enters
// design mode (or is created in it):
//
//   pointer exists + is recognized    → use it.
//   pointer exists but unrecognized   → refuse; policy cannot target source.
//   pointer missing, 0 discovered     → first design use. An EXPLICIT pointer
//                                       is created under its own name; the
//                                       implicit default is named after the
//                                       repository ("<repo> - Design", see
//                                       firstUseDesignDirectoryName) so a
//                                       user's first design folder reads as
//                                       theirs, not as a product artifact.
//                                       "Zeros Design" remains the unconfigured
//                                       POINTER value for compatibility: a
//                                       checkout that already carries that
//                                       folder keeps using it.
//   pointer missing, exactly 1 found  → adopt it (the copy-paste/migration
//                                       case) — never silently create a
//                                       SECOND design folder next to it.
//   pointer missing, several found    → refuse and name them; picking one is
//                                       a settings decision, not a guess.
//
// The resolved name is PRIMED into design/directory-registry.ts so the many
// synchronous consumers (document reads, protocol resources, lock sweeps)
// agree with the async decision made here.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { projectNameForRoot } from "../db/projects";
import { GitError } from "../git/errors";
import { runGit } from "../git/git-exec";
import { opSettingsResolve } from "../settings/ops";
import {
  DEFAULT_DESIGN_DIRECTORY_NAME,
  designDirectoryNameFor,
  primeDesignDirectoryName,
  sanitizeDesignDirectoryName,
} from "./directory-registry";

/** Suffix appended to the repository's name for a first-use Design folder. */
export const FIRST_USE_DESIGN_DIRECTORY_SUFFIX = " - Design";

/** Keep "<name> - Design" comfortably inside every filesystem's 255-byte leaf
 *  limit even for multi-byte names; long repository names are truncated, not
 *  refused. */
const MAX_FIRST_USE_REPO_NAME_CHARS = 60;

/** The folder name Design mode creates on a repository's FIRST design use when
 *  no `[design] directory` pointer is configured: the repository's display
 *  name plus " - Design" ("Odocs - Design"). Total function: separators and
 *  control bytes in the name become spaces, a leading dot is dropped so the
 *  folder is never hidden, and anything the registry would refuse falls back
 *  to the historical default. */
export function firstUseDesignDirectoryName(repoName: string): string {
  const cleaned = repoName
    .replace(/[\\/\0\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const bounded = Array.from(cleaned)
    .slice(0, MAX_FIRST_USE_REPO_NAME_CHARS)
    .join("")
    .trim();
  if (!bounded) return DEFAULT_DESIGN_DIRECTORY_NAME;
  return (
    sanitizeDesignDirectoryName(
      `${bounded}${FIRST_USE_DESIGN_DIRECTORY_SUFFIX}`,
    ) ?? DEFAULT_DESIGN_DIRECTORY_NAME
  );
}

/** The name a repository shows in the UI: its registered project name (the
 *  user may have renamed it) or the checkout folder's basename. The registry
 *  read is best-effort — an unopened DB, an unregistered root, or a test
 *  fixture without one all answer with the basename. */
export function repoDisplayNameForRoot(repoRoot: string): string {
  let registered: string | null = null;
  try {
    registered = projectNameForRoot(repoRoot);
  } catch {
    registered = null;
  }
  return registered ?? path.basename(path.resolve(repoRoot));
}

/** First-use Design folder for a repository root — see
 *  firstUseDesignDirectoryName. */
export function firstUseDesignDirectoryNameForRepo(repoRoot: string): string {
  return firstUseDesignDirectoryName(repoDisplayNameForRoot(repoRoot));
}

/** Validate a human-selected pointer against the checkout it will control.
 * Existing workspaces may only switch to a real, committed Design document;
 * this prevents a settings edit from redirecting the mutation/fence boundary
 * onto arbitrary source or a symlink. The first-use default remains handled by
 * resolveDesignDirectoryForEnter(), not this transition path. */
export async function validateDesignDirectoryPointerTarget(
  cwd: string,
  requested: unknown,
): Promise<string> {
  const name = sanitizeDesignDirectoryName(requested);
  if (!name) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Design folder names must be repo-relative paths.",
    });
  }
  const target = path.join(cwd, ...name.split("/"));
  let targetReal: string;
  let rootReal: string;
  try {
    const [targetStat, canonicalTarget, canonicalRoot] = await Promise.all([
      stat(target),
      realpath(target),
      realpath(cwd),
    ]);
    if (!targetStat.isDirectory()) throw new Error("not a directory");
    targetReal = canonicalTarget;
    rootReal = canonicalRoot;
  } catch {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `The Design folder "${name}" does not exist in this checkout.`,
      remediation:
        "Choose a folder listed in the Design settings, or initialize it through Design mode first.",
    });
  }
  if (
    targetReal === rootReal ||
    !targetReal.startsWith(rootReal + path.sep) ||
    path.relative(rootReal, targetReal).split(path.sep).join("/") !== name
  ) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `The Design folder "${name}" must be a real, symlink-free directory inside this checkout.`,
    });
  }
  const discovered = await discoverDesignDirectories(cwd);
  if (!discovered.includes(name)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `The Design folder "${name}" is not a committed Design document.`,
      remediation:
        "Choose a folder containing a committed .zeros-canvas.json marker.",
    });
  }
  return name;
}

/** Read the `[design] directory` pointer for a workspace (or a bare repo
 *  root), already sanitized, falling back to the default. `workspacePath`
 *  resolves the full layer stack (committed repo file at the WORKTREE's
 *  checkout of it, repo-local from the main checkout, the worktree's own
 *  pin); a bare repoRoot reads the repo layers only. */
export async function resolveDesignDirectoryPointer(opts: {
  repoRoot: string;
  workspacePath?: string;
}): Promise<string> {
  return (await resolveDesignDirectoryPointerState(opts)).directory;
}

/** Pointer value plus provenance needed by admission. An explicitly selected
 * but not-yet-created directory is prospective Design authority; an absent
 * setting with the same default string is still an ordinary code workspace. */
export async function resolveDesignDirectoryPointerState(opts: {
  repoRoot: string;
  workspacePath?: string;
}): Promise<{
  directory: string;
  configured: boolean;
  valid: boolean;
}> {
  let raw: unknown;
  let configured = false;
  try {
    const resolved = opts.workspacePath
      ? opSettingsResolve(opts.workspacePath, opts.repoRoot)
      : opSettingsResolve(opts.repoRoot);
    raw = (resolved.effective as { design?: { directory?: unknown } }).design
      ?.directory;
    configured = resolved.sources["design.directory"] !== undefined;
  } catch {
    raw = undefined;
  }
  const sanitized = sanitizeDesignDirectoryName(raw);
  return {
    directory: sanitized ?? DEFAULT_DESIGN_DIRECTORY_NAME,
    configured,
    valid: !configured || sanitized !== null,
  };
}

function portableDirectoryKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function prospectivePathError(directory: string, detail: string): Error {
  return new Error(
    `The prospective Design path must have real, symlink-free directory ` +
      `parents; "${directory}" ${detail}.`,
  );
}

/** Validate every currently existing segment of a configured future Design
 * root without requiring the leaf to exist. This is deliberately owned by the
 * Design module: code-agent admission may inspect this authority, but it must
 * not invent or reinterpret Design paths itself. */
export async function assertSafeProspectiveDesignDirectory(
  workspacePath: string,
  directory: string,
): Promise<void> {
  const sanitized = sanitizeDesignDirectoryName(directory);
  if (!sanitized || sanitized !== directory) {
    throw new Error(
      "The prospective Design path is not a safe repo-relative directory.",
    );
  }
  // Validate child entries from the physical root. macOS exposes temporary
  // paths through `/var` while realpath reports `/private/var`; comparing a
  // physical child with that harmless caller spelling would otherwise reject
  // an ordinary empty reservation. Callers that require a canonical workspace
  // identity (agent admission and vnode reservation) enforce that separately.
  let parent = await realpath(path.resolve(workspacePath));
  for (const segment of sanitized.split("/")) {
    const entries = await readdir(parent);
    const aliases = entries.filter(
      (entry) => portableDirectoryKey(entry) === portableDirectoryKey(segment),
    );
    if (
      aliases.length > 0 &&
      (aliases.length !== 1 || aliases[0] !== segment)
    ) {
      throw new Error(
        `The prospective Design path must use the exact on-disk spelling; ` +
          `got "${segment}", found "${aliases.join('", "')}".`,
      );
    }
    if (aliases.length === 0) return;
    parent = path.join(parent, segment);
    const [info, canonical] = await Promise.all([
      lstat(parent),
      realpath(parent),
    ]);
    if (info.isSymbolicLink() || !info.isDirectory() || canonical !== parent) {
      throw prospectivePathError(directory, "does not satisfy that contract");
    }
  }
}

/** Create an empty vnode for an explicitly configured, absent Design root.
 *
 * macOS Seatbelt cannot reserve a path which has no vnode. Admission therefore
 * asks the trusted Design surface to create this empty lease before compiling
 * the immutable code-agent profile. It creates no document files, accepts no
 * arbitrary non-empty directory, verifies every segment after creation, and
 * is never called by read-only preflight.
 *
 * The untrusted process does not exist yet while this runs. We still compare
 * parent identities around each mkdir and fail closed on any concurrent path
 * replacement; admission then performs a second full territory resolution.
 */
export async function reserveProspectiveDesignDirectory(
  workspacePath: string,
  directory: string,
): Promise<string> {
  const root = path.resolve(workspacePath);
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {
    throw prospectivePathError(
      directory,
      "cannot be reserved through a workspace alias",
    );
  }
  await assertSafeProspectiveDesignDirectory(root, directory);

  let parent = canonicalRoot;
  for (const segment of directory.split("/")) {
    const parentBefore = await lstat(parent);
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
      throw prospectivePathError(directory, "has an unsafe parent");
    }
    const entries = await readdir(parent);
    const aliases = entries.filter(
      (entry) => portableDirectoryKey(entry) === portableDirectoryKey(segment),
    );
    if (
      aliases.length > 0 &&
      (aliases.length !== 1 || aliases[0] !== segment)
    ) {
      throw new Error(
        `The prospective Design path must use the exact on-disk spelling; ` +
          `got "${segment}", found "${aliases.join('", "')}".`,
      );
    }
    const candidate = path.join(parent, segment);
    if (aliases.length === 0) {
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (error: unknown) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (code !== "EEXIST") throw error;
      }
    }
    const [parentAfter, info, canonical] = await Promise.all([
      lstat(parent),
      lstat(candidate),
      realpath(candidate),
    ]);
    if (
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino ||
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      canonical !== candidate
    ) {
      throw prospectivePathError(directory, "changed during reservation");
    }
    parent = candidate;
  }

  if ((await readdir(parent)).length > 0) {
    throw new Error(
      `The prospective Design path "${directory}" became non-empty before ` +
        "the isolation lease was established.",
    );
  }
  return parent;
}

async function isEmptyProspectiveDesignDirectory(
  workspacePath: string,
  directory: string,
): Promise<boolean> {
  await assertSafeProspectiveDesignDirectory(workspacePath, directory);
  const target = path.join(workspacePath, ...directory.split("/"));
  const info = await lstat(target);
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (await readdir(target)).length === 0
  );
}

/** Marker-directory caches for discoverDesignDirectories(). Both are keyed by
 * the exact evidence Git itself reads, so an entry can never be fresher or
 * staler than the repository state that produced it:
 *
 *   - index evidence is keyed by the index file's physical identity
 *     (inode + size + timestamps). Git replaces the index atomically via
 *     rename, so every index write mints a new inode and misses the cache.
 *   - HEAD evidence is keyed by the resolved commit oid. A commit's tree is
 *     content-addressed, so the marker set for one oid is immutable — and
 *     shareable across worktrees/workspaces sitting on the same commit, which
 *     is exactly the managed-sibling case where the full-tree `ls-tree -r`
 *     scan used to be repaid per admission.
 *
 * A miss on either side re-runs the real Git command; failures are never
 * cached, so the fail-closed propagation below is unchanged. */
const MAX_DISCOVERY_CACHE_ENTRIES = 256;
const indexMarkerCache = new Map<
  string,
  { signature: string; directories: readonly string[] }
>();
const headTreeMarkerCache = new Map<string, readonly string[]>();
let discoveryCacheHits = 0;
let discoveryCacheMisses = 0;

function rememberBounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_DISCOVERY_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

function recallBounded<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  // Refresh recency so hot workspaces are not evicted by one-off lookups.
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/** Physical identity of the index file whose contents `git ls-files` reads.
 * Returns null when the identity cannot be established (non-repo, unreadable
 * `.git`), which disables caching for that call rather than guessing. */
async function indexEvidenceSignature(cwd: string): Promise<string | null> {
  try {
    const gitEntry = path.join(cwd, ".git");
    // Classify and read `.git` through ONE descriptor. Statting the path and
    // then reading it by path again is a check-then-use on two different
    // resolutions: the entry can be swapped between them, so the bytes fed to
    // the gitdir parser need not be the bytes that were classified. The handle
    // pins the exact inode for both. O_NOFOLLOW keeps the previous lstat
    // semantics — a symlinked `.git` fails to open (ELOOP) and lands in the
    // outer catch, which is the same "no cacheable identity" answer lstat gave
    // by reporting neither a directory nor a regular file.
    // The 0o600 is the mode a CREATED file would get. O_RDONLY without
    // O_CREAT cannot create one, so it is inert today; it is stated anyway so
    // the call is owner-only by construction if a creating flag is ever added,
    // and so static analysis does not have to infer that from the flags.
    const handle = await open(
      gitEntry,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let gitDir: string;
    try {
      const entryStat = await handle.stat();
      if (entryStat.isDirectory()) {
        gitDir = gitEntry;
      } else if (entryStat.isFile()) {
        const contents = await handle.readFile("utf8");
        const match = /^gitdir:\s*(.+)\s*$/m.exec(contents);
        if (!match?.[1]) return null;
        gitDir = path.resolve(cwd, match[1]);
      } else {
        return null;
      }
    } finally {
      await handle.close();
    }
    const indexPath = path.join(gitDir, "index");
    try {
      const indexStat = await lstat(indexPath);
      if (!indexStat.isFile()) return null;
      return `${gitDir}\0${indexStat.ino}:${indexStat.size}:${indexStat.mtimeMs}:${indexStat.ctimeMs}`;
    } catch {
      // A repository with no index yet still has a stable "absent" identity.
      return `${gitDir}\0absent`;
    }
  } catch {
    return null;
  }
}

function markerDirectories(listing: string): readonly string[] {
  const found = new Set<string>();
  for (const file of listing.split("\0")) {
    if (!file || !file.endsWith("/.zeros-canvas.json")) continue;
    const sanitized = sanitizeDesignDirectoryName(path.posix.dirname(file));
    if (sanitized) found.add(sanitized);
  }
  return [...found];
}

/** Test-only cache introspection/reset. Production code never calls these. */
export function resetDesignDiscoveryCacheForTests(): void {
  indexMarkerCache.clear();
  headTreeMarkerCache.clear();
  discoveryCacheHits = 0;
  discoveryCacheMisses = 0;
}

export function designDiscoveryCacheStatsForTests(): {
  hits: number;
  misses: number;
} {
  return { hits: discoveryCacheHits, misses: discoveryCacheMisses };
}

/** Every design directory evidenced by either HEAD or the current index,
 *  repo-relative and sorted. Taking the union is intentional: a staged rename
 *  must retain both the committed source and staged destination until the
 *  territory transition is reconciled. Depth ≥ 1 only — a marker at the repo
 *  root would make the repo root itself the design folder, which the lock and
 *  write boundary both refuse. */
export async function discoverDesignDirectories(
  cwd: string,
): Promise<string[]> {
  const found = new Set<string>();

  const indexSignature = await indexEvidenceSignature(cwd);
  const cachedIndex = indexSignature
    ? recallBounded(indexMarkerCache, cwd)
    : undefined;
  if (cachedIndex && cachedIndex.signature === indexSignature) {
    discoveryCacheHits += 1;
    for (const dir of cachedIndex.directories) found.add(dir);
  } else {
    try {
      const { stdout } = await runGit(cwd, [
        "ls-files",
        "-z",
        "--",
        "*/.zeros-canvas.json",
      ]);
      const directories = markerDirectories(stdout);
      for (const dir of directories) found.add(dir);
      // Stat-read-stat: cache this listing only if the index is byte-for-byte
      // the same identity it was before ls-files ran. If a concurrent Git write
      // replaced the index mid-read (atomic rename → new inode), skip caching
      // so the (possibly torn) listing is never stored under a stale key.
      if (indexSignature) {
        const afterSignature = await indexEvidenceSignature(cwd);
        if (afterSignature === indexSignature) {
          discoveryCacheMisses += 1;
          rememberBounded(indexMarkerCache, cwd, {
            signature: indexSignature,
            directories,
          });
        }
      }
    } catch {
      // An unborn/non-Git checkout has no index recognition. Keep trying HEAD
      // so one transient command failure cannot erase otherwise committed
      // evidence. Failures are never cached.
    }
  }

  let hasHead = false;
  let headOid: string | null = null;
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
    hasHead = true;
    const oid = stdout.trim();
    // A non-hex verify result cannot key the immutable-tree cache; the scan
    // below still runs uncached against HEAD so committed evidence survives.
    if (/^[0-9a-f]{40,64}$/i.test(oid)) headOid = oid;
  } catch {
    // No HEAD is normal during first initialization. Index evidence above is
    // still usable.
  }
  if (hasHead) {
    const cachedHead = headOid
      ? recallBounded(headTreeMarkerCache, headOid)
      : undefined;
    if (cachedHead) {
      discoveryCacheHits += 1;
      for (const dir of cachedHead) found.add(dir);
    } else {
      // `ls-tree` does not implement the same recursive wildcard pathspec as
      // `ls-files`; enumerate names and filter in-process. If this bounded read
      // fails, propagate the error rather than erase committed Design evidence.
      const { stdout } = await runGit(
        cwd,
        ["ls-tree", "-r", "-z", "--name-only", headOid ?? "HEAD"],
        { maxBufferBytes: 64 * 1024 * 1024 },
      );
      const directories = markerDirectories(stdout);
      for (const dir of directories) found.add(dir);
      if (headOid) {
        discoveryCacheMisses += 1;
        rememberBounded(headTreeMarkerCache, headOid, directories);
      }
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/** Decide which folder design mode should target for this workspace, per the
 *  policy in the module header, and PRIME the registry with the answer so
 *  every synchronous consumer agrees.
 *
 *  Strict (the default — user-initiated mode entry): several candidates with
 *  a dangling pointer throw (registry untouched); picking one is a settings
 *  decision, not a guess. Non-strict (restore / boot reconcile, which must
 *  always succeed): the same case falls back to the first candidate so the
 *  workspace comes back usable, and the picker can correct it later. */
export async function previewDesignDirectoryForEnter(
  workspace: {
    path: string;
    repoRoot: string;
  },
  opts: {
    strict?: boolean;
    /** Folders Zeros already knows are Design documents even when they are
     * intentionally absent from an engine-owned sparse checkout. Callers must
     * supply only validated sticky/shape identities. Code-agent admission and
     * mode entry pass the durable shape so the active name and protected set
     * are chosen from one authority universe. */
    additionalRecognized?: readonly string[];
  } = {},
): Promise<string> {
  const strict = opts.strict !== false;
  const pointerState = await resolveDesignDirectoryPointerState({
    repoRoot: workspace.repoRoot,
    workspacePath: workspace.path,
  });
  const pointer = pointerState.directory;
  let name = pointer;
  const pointerExists = existsSync(
    path.join(workspace.path, ...pointer.split("/")),
  );
  const additionalRecognized = [
    ...new Set(
      (opts.additionalRecognized ?? []).flatMap((candidate) => {
        const safe = sanitizeDesignDirectoryName(candidate);
        return safe ? [safe] : [];
      }),
    ),
  ];
  const intentionallyAbsent = additionalRecognized.filter(
    (candidate) =>
      !existsSync(path.join(workspace.path, ...candidate.split("/"))),
  );
  const pointerCoveredByAbsentAuthority = intentionallyAbsent.some(
    (candidate) => pointer === candidate || pointer.startsWith(`${candidate}/`),
  );
  const discovered = [
    ...new Set([
      ...(await discoverDesignDirectories(workspace.path)),
      ...additionalRecognized,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (pointerExists) {
    // A worktree settings file is ordinary repository content. It may select
    // among recognized Design documents, but it must never be able to redirect
    // the engine mutation/fence boundary onto arbitrary source. The first-use
    // default is the sole exception: an empty/default directory is initialized
    // by Design mode itself, below the structured transition boundary.
    // The historical default is also the first-use bootstrap destination. A
    // checkout hook may have pre-seeded it untracked before Design mode runs;
    // preserve and commit that seed instead of demanding a second empty
    // directory. Non-default pointers still require a committed marker: a
    // settings edit must never designate arbitrary source as Design territory.
    const needsProspectiveRecognition =
      pointer !== DEFAULT_DESIGN_DIRECTORY_NAME &&
      !discovered.includes(pointer);
    const reservedProspective =
      needsProspectiveRecognition &&
      pointerState.configured &&
      (await isEmptyProspectiveDesignDirectory(workspace.path, pointer));
    if (needsProspectiveRecognition && !reservedProspective) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `The configured Design folder "${pointer}" is not a committed Design document.`,
        remediation:
          "Choose a folder containing a committed .zeros-canvas.json marker, or remove the unrecognized folder before initializing Design mode.",
      });
    }
  } else {
    if (pointerCoveredByAbsentAuthority) {
      // Sparse checkout deliberately removed this configured, recognized
      // document. Preserve the explicit pointer even when several protected
      // documents exist; suspension will materialize all of them next.
      name = pointer;
    } else if (discovered.length === 1) {
      name = discovered[0]!;
    } else if (discovered.length > 1) {
      if (!strict) {
        name = discovered[0]!;
      } else {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message:
            `The design folder "${pointer}" doesn't exist here, and ` +
            `${discovered.length} design folders were found: ${discovered
              .slice(0, 4)
              .join(", ")}${discovered.length > 4 ? ", …" : ""}.`,
          remediation:
            "Choose the active design folder in this repo's settings (Design tab), then switch to design mode again.",
        });
      }
    } else if (!pointerState.configured) {
      // 0 discovered and nothing configured → this repository's first design
      // use. Name the new document after the repository rather than after the
      // product; initialization creates it fresh under that name. The
      // historical "Zeros Design" pointer still wins above whenever that folder
      // already exists in the checkout, so pre-naming checkouts are unchanged.
      const firstUseName = firstUseDesignDirectoryNameForRepo(
        workspace.repoRoot,
      );
      const firstUseTarget = path.join(
        workspace.path,
        ...firstUseName.split("/"),
      );
      if (existsSync(firstUseTarget)) {
        try {
          // A Code-agent sandbox may already have reserved this exact name as
          // an empty vnode. That is safe to initialize. Any other unrecognized
          // content is user territory: never add a Design marker beside it and
          // silently change its authority just because the names collide.
          await assertSafeProspectiveDesignDirectory(
            workspace.path,
            firstUseName,
          );
          if (
            !(await isEmptyProspectiveDesignDirectory(
              workspace.path,
              firstUseName,
            ))
          ) {
            throw new Error("the target is not empty");
          }
        } catch (cause) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: `The first-use Design folder "${firstUseName}" already exists and is not an empty reservation or recognized Design document.`,
            remediation:
              "Move or rename that folder, or select a recognized Design folder in this repository's Design settings.",
            cause,
          });
        }
      }
      name = firstUseName;
    }
    // 0 discovered with an EXPLICIT pointer → keep the pointer and let
    // initialization create it fresh.
  }
  return name;
}

/** Publish the previewed semantic identity for synchronous Design consumers.
 * Keeping preview and publication separate lets Git/settings reconciliation
 * compare a prospective territory with live agent sandboxes before changing
 * the active registry. */
export async function resolveDesignDirectoryForEnter(
  workspace: {
    path: string;
    repoRoot: string;
  },
  opts: { strict?: boolean; additionalRecognized?: readonly string[] } = {},
): Promise<string> {
  const name = await previewDesignDirectoryForEnter(workspace, opts);
  primeDesignDirectoryName(workspace.path, name);
  return name;
}

/** Re-resolve and re-prime a live design-mode workspace after a settings
 *  change, WITHOUT the adoption/creation policy (no filesystem mutations):
 *  the new pointer takes effect only if that folder actually exists in the
 *  checkout — otherwise the current answer is kept so open documents don't
 *  dangle mid-session. Returns the (possibly unchanged) active name. */
export async function refreshDesignDirectoryPointer(
  workspace: {
    path: string;
    repoRoot: string;
  },
  opts: {
    /** Authority changes are creation-time. Callers use this seam to retire
     * processes admitted under the old pointer, then invoke `publish` while
     * their process-start block is still held. Throwing before `publish` leaves
     * the registry untouched. */
    beforePublish?: (
      nextName: string,
      publish: () => Promise<void>,
    ) => Promise<void>;
  } = {},
): Promise<string> {
  const pointer = await resolveDesignDirectoryPointer({
    repoRoot: workspace.repoRoot,
    workspacePath: workspace.path,
  });
  if (existsSync(path.join(workspace.path, ...pointer.split("/")))) {
    const current = designDirectoryNameFor(workspace.path);
    const publish = async (): Promise<void> => {
      primeDesignDirectoryName(workspace.path, pointer);
    };
    if (pointer !== current && opts.beforePublish) {
      await opts.beforePublish(pointer, publish);
    } else {
      await publish();
    }
    return pointer;
  }
  return designDirectoryNameFor(workspace.path);
}
