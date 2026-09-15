// Disposable file-stat cache for snapshots. Commits/refs remain the durable
// recovery record; this cache can be lost or evicted without losing any work.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runGit } from "./git-exec";

const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;
const MAX_ATTRIBUTE_DIRECTORIES = 4_096;

interface CachedIndex extends SnapshotRules {
  bytes: Buffer;
  timestamp: number;
  signature: string;
  treeSignature: string;
  tree: string;
  keepsHeadPaths: boolean;
  attributePaths: string[];
}

interface SnapshotRules {
  forceAddPaths?: string[];
  excludePaths?: string[];
}

interface IndexContext {
  signature: string;
  treeSignature: string;
  priorSignature: string;
  priorTreeSignature: string;
  attributePaths: string[];
}

const indices = new Map<string, CachedIndex>();
let cachedBytes = 0;

function forget(key: string): void {
  const old = indices.get(key);
  if (old) cachedBytes -= old.bytes.length;
  indices.delete(key);
}

function remember(key: string, entry: CachedIndex): void {
  forget(key);
  indices.set(key, entry);
  cachedBytes += entry.bytes.length;
  while (indices.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
    forget(indices.keys().next().value!);
  }
}

function booleanFalse(value: string | undefined): boolean {
  return value !== undefined && /^(false|no|off|0)$/i.test(value);
}

/** Include all attribute ancestors of potentially reused paths, even ignored
 * .gitattributes files. Git's stat shortcut is only valid under the same
 * normalization rules. Reusing untracked/forced entries additionally requires
 * the same HEAD/ignore files and compatible inclusion/exclusion rules. Adding
 * forced paths or exclusions is safe; removing either resets to HEAD. */
async function context(
  cwd: string,
  gitDir: string,
  previousPaths: readonly string[],
  indexFile?: string,
): Promise<IndexContext | null> {
  const [configuration, tracked, common, head] = await Promise.all([
    runGit(cwd, ["config", "--null", "--list", "--includes"]),
    runGit(
      cwd,
      ["ls-files", "--cached", "-z"],
      indexFile ? { env: { GIT_INDEX_FILE: indexFile } } : {},
    ),
    readFile(path.join(gitDir, "commondir"), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }),
    runGit(cwd, ["rev-parse", "--verify", "HEAD"]).then(
      (result) => result.stdout.trim(),
      () => "",
    ),
  ]);
  const config = new Map(
    configuration.stdout
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const newline = record.indexOf("\n");
        if (newline < 0) return [record.toLowerCase(), "true"];
        return [
          record.slice(0, newline).toLowerCase(),
          record.slice(newline + 1),
        ];
      }),
  );
  // These settings intentionally weaken stat verification or change index
  // representation. Keep the established fresh-index path for them.
  if (
    booleanFalse(config.get("core.trustctime")) ||
    (config.has("core.checkstat") &&
      config.get("core.checkstat") !== "default") ||
    ["core.ignorestat", "core.sparsecheckout", "core.splitindex"].some(
      (key) => config.has(key) && !booleanFalse(config.get(key)),
    )
  )
    return null;

  const paths = new Set(previousPaths);
  paths.add(path.join(cwd, ".gitattributes"));
  for (const file of tracked.stdout.split("\0")) {
    if (!file) continue;
    if (path.posix.isAbsolute(file) || file.split("/").includes(".."))
      return null;
    let directory = path.posix.dirname(file);
    while (directory !== ".") {
      paths.add(path.join(cwd, directory, ".gitattributes"));
      if (paths.size > MAX_ATTRIBUTE_DIRECTORIES) return null;
      directory = path.posix.dirname(directory);
    }
  }
  paths.add(path.resolve(gitDir, common.trim() || ".", "info/attributes"));
  const configuredAttributes = config.get("core.attributesfile");
  if (
    configuredAttributes?.startsWith("~") &&
    !configuredAttributes.startsWith("~/")
  )
    return null;
  if (configuredAttributes?.includes("%(")) return null;
  paths.add(
    configuredAttributes
      ? path.resolve(
          cwd,
          configuredAttributes.startsWith("~/")
            ? path.join(homedir(), configuredAttributes.slice(2))
            : configuredAttributes,
        )
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
          "git/attributes",
        ),
  );
  const attributePaths = [...paths].sort();
  // Git falls back to indexed attributes when a worktree attribute file is
  // absent. A different HEAD therefore invalidates normalization as well.
  const digest = createHash("sha256").update(configuration.stdout).update(head);
  const priorDigest = createHash("sha256")
    .update(configuration.stdout)
    .update(head);
  const knownAttributes = new Set(previousPaths);
  const knownIgnores = new Set(
    previousPaths
      .filter((file) => path.basename(file) === ".gitattributes")
      .map((file) => path.join(path.dirname(file), ".gitignore")),
  );
  const ignorePaths = new Set(
    attributePaths
      .filter((file) => path.basename(file) === ".gitattributes")
      .map((file) => path.join(path.dirname(file), ".gitignore")),
  );
  const repositoryExcludes = path.resolve(
    gitDir,
    common.trim() || ".",
    "info/exclude",
  );
  ignorePaths.add(repositoryExcludes);
  knownIgnores.add(repositoryExcludes);
  const configuredExcludes = config.get("core.excludesfile");
  if (
    configuredExcludes?.startsWith("~") &&
    !configuredExcludes.startsWith("~/")
  )
    return null;
  if (configuredExcludes?.includes("%(")) return null;
  const globalExcludes = configuredExcludes
    ? path.resolve(
        cwd,
        configuredExcludes.startsWith("~/")
          ? path.join(homedir(), configuredExcludes.slice(2))
          : configuredExcludes,
      )
    : path.join(
        process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
        "git/ignore",
      );
  ignorePaths.add(globalExcludes);
  knownIgnores.add(globalExcludes);
  const inclusion = createHash("sha256").update(head).update("\0");
  const priorInclusion = createHash("sha256").update(head).update("\0");
  const evidencePaths = [...attributePaths, ...[...ignorePaths].sort()];
  // Bound I/O fanout and metadata size. Any uncertainty disables the cache.
  for (let offset = 0; offset < evidencePaths.length; offset += 32) {
    const entries = await Promise.all(
      evidencePaths.slice(offset, offset + 32).map(async (file) => {
        try {
          const handle = await open(
            file,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.size > 1024 * 1024)
              throw new Error("Uncacheable attributes");
            const bytes = await handle.readFile();
            const after = await handle.stat();
            if (
              before.size !== after.size ||
              before.mtimeMs !== after.mtimeMs ||
              before.ctimeMs !== after.ctimeMs
            )
              throw new Error("Attributes changed during snapshot");
            return bytes;
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" ||
            (error as NodeJS.ErrnoException).code === "ENOTDIR"
          )
            return null;
          throw error;
        }
      }),
    );
    entries.forEach((bytes, index) => {
      // Newly discovered directories with no rules do not invalidate a tree.
      // Their paths are retained so a later rule creation is still detected.
      if (bytes === null) return;
      const target =
        offset + index < attributePaths.length ? digest : inclusion;
      const file = evidencePaths[offset + index];
      const hash = createHash("sha256").update(bytes).digest("hex");
      target.update(file).update("\0").update(hash).update("\0");
      const known =
        offset + index < attributePaths.length
          ? knownAttributes.has(file)
          : knownIgnores.has(file);
      if (known) {
        const prior =
          offset + index < attributePaths.length ? priorDigest : priorInclusion;
        prior.update(file).update("\0").update(hash).update("\0");
      }
    });
  }
  return {
    signature: digest.digest("hex"),
    treeSignature: inclusion.digest("hex"),
    priorSignature: priorDigest.digest("hex"),
    priorTreeSignature: priorInclusion.digest("hex"),
    attributePaths,
  };
}

export interface SnapshotIndexCache {
  reused: boolean;
  tree?: string;
  validate(): Promise<void>;
  publish(tree: string): Promise<void>;
}

/** Each caller receives a separate scratch file. Concurrent turns can borrow
 * the same immutable bytes; they never share a mutable index or index lock. */
export async function prepareSnapshotIndex(
  cwd: string,
  gitDir: string,
  scratch: string,
  rules: SnapshotRules = {},
): Promise<SnapshotIndexCache> {
  const cold: SnapshotIndexCache = {
    reused: false,
    validate: async () => {},
    publish: async () => {},
  };
  try {
    const [root, metadata, rootStat, gitStat] = await Promise.all([
      realpath(cwd),
      realpath(gitDir),
      lstat(cwd),
      lstat(gitDir),
    ]);
    const key = `${root}\0${metadata}\0${rootStat.dev}:${rootStat.ino}:${gitStat.dev}:${gitStat.ino}`;
    const previous = indices.get(key);
    const before = await context(
      root,
      metadata,
      previous?.attributePaths ?? [],
    );
    if (!before) return cold;
    const reused = previous?.signature === before.signature;
    if (reused) {
      await writeFile(scratch, previous.bytes, { flag: "wx", mode: 0o600 });
      // Copying with a new timestamp would defeat Git's racy-clean detection.
      // Round down with a millisecond margin, never forward, before Git reads
      // the index. Git then smudges/rechecks entries newer than that timestamp.
      await utimes(scratch, previous.timestamp, previous.timestamp);
    }
    let validated = false;
    let verified = before;
    return {
      reused,
      ...(reused &&
      previous.keepsHeadPaths &&
      previous.treeSignature === before.treeSignature &&
      (previous.forceAddPaths ?? []).every((file) =>
        rules.forceAddPaths?.includes(file),
      ) &&
      (previous.excludePaths ?? []).every((file) =>
        rules.excludePaths?.includes(file),
      )
        ? { tree: previous.tree }
        : {}),
      async validate() {
        const after = await context(
          root,
          metadata,
          before.attributePaths,
          scratch,
        ).catch(() => null);
        const priorValid =
          after?.priorSignature === before.signature &&
          after?.priorTreeSignature === before.treeSignature;
        validated =
          priorValid &&
          after?.signature === before.signature &&
          after?.treeSignature === before.treeSignature;
        if (validated && after) verified = after;
        if (!validated) {
          forget(key);
          // Newly included ignored scopes can introduce additional rule files.
          // They did not govern any reused entry: finish their fresh capture,
          // but don't cache bytes whose complete rule set wasn't known upfront.
          if (reused && !priorValid)
            throw new Error("Snapshot normalization changed during capture");
        }
      },
      async publish(tree) {
        if (!validated) return;
        // A cached deletion must not make a recreated HEAD-tracked file look
        // untracked (and therefore disappear if it also matches .gitignore).
        // Keep its stat cache, but reset from HEAD on the next capture.
        const keepsHeadPaths = await runGit(root, [
          "diff-tree",
          "--quiet",
          "--diff-filter=D",
          "-r",
          "HEAD",
          tree,
        ]).then(
          () => true,
          () => false,
        );
        const handle = await open(
          scratch,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > MAX_INDEX_BYTES) return;
          const bytes = await handle.readFile();
          if (bytes.length !== info.size) return;
          remember(key, {
            bytes,
            timestamp: (Math.floor(info.mtimeMs) - 1) / 1000,
            signature: verified.signature,
            treeSignature: verified.treeSignature,
            tree,
            keepsHeadPaths,
            forceAddPaths: [...(rules.forceAddPaths ?? [])],
            excludePaths: [...(rules.excludePaths ?? [])],
            attributePaths: verified.attributePaths,
          });
        } finally {
          await handle.close();
        }
      },
    };
  } catch {
    // A failed timestamp restore must not leave a copy that appears newer
    // than its evidence. Fall back to an actually empty scratch index.
    await rm(scratch, { force: true });
    return cold;
  }
}
