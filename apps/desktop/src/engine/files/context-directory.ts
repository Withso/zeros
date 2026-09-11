// On-disk context layout. Wire operation names and saved .context-graph paths
// remain compatibility contracts; only new filesystem writes use .context.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { runFile } from "../git/git-exec";
import {
  assertContextDirectory,
  CONTEXT_DIR,
  LEGACY_CONTEXT_DIR,
  statIfPresent,
} from "./context-paths";
import {
  CONTEXT_MIGRATION_STATE,
  recordMigratedRootFiles,
  recoverContextMigration,
  retireLegacyContextFile,
} from "./context-migration-state";
export {
  assertContextDirectory,
  CONTEXT_DIR,
  LEGACY_CONTEXT_DIR,
} from "./context-paths";

async function fileDigest(target: string): Promise<string> {
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function identicalFiles(
  source: string,
  target: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([
    statIfPresent(source),
    statIfPresent(target),
  ]);
  if (!a?.isFile() || !b?.isFile() || a.size !== b.size) return false;
  if (a.dev === b.dev && a.ino === b.ino) return true;
  return (await fileDigest(source)) === (await fileDigest(target));
}

function mergeableIgnoreFile(relative: string): boolean {
  return (
    relative === ".gitignore" || relative === path.join("local", ".gitignore")
  );
}

async function readTextFile(target: string): Promise<string> {
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("context metadata is not a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function copiedFileMatches(
  source: string,
  target: string,
  relative: string,
): Promise<boolean> {
  if (!mergeableIgnoreFile(relative)) return identicalFiles(source, target);
  return (await readTextFile(target)).includes(await readTextFile(source));
}

/** Preserve existing ignore text. No-follow append also refuses symlinked
 * ignore files; sharing must not edit a file outside this checkout. */
async function appendIgnore(target: string, body: string): Promise<boolean> {
  const handle = await fs.open(
    target,
    constants.O_RDWR |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("gitignore is not a regular file");
    const existing = await handle.readFile("utf8");
    if (existing.includes(body)) return false;
    await handle.writeFile(
      `${existing && !existing.endsWith("\n") ? "\n" : ""}${body}`,
    );
    return true;
  } finally {
    await handle.close();
  }
}

/** Merge without replacing a destination. Preflight catches ordinary conflicts
 * before moving anything; exclusive hard links preserve bytes, modes and mtime.
 * Source removal uses a recoverable rename so a concurrent atomic save cannot
 * be deleted between the copy and unlink. */
export async function migrateLegacyContextDirectory(
  workspaceRoot: string,
): Promise<boolean> {
  const recovered = await recoverContextMigration(
    workspaceRoot,
    copiedFileMatches,
  );
  const sourceRoot = path.join(workspaceRoot, LEGACY_CONTEXT_DIR);
  if (!(await statIfPresent(sourceRoot))) return recovered;
  const targetRoot = path.join(workspaceRoot, CONTEXT_DIR);
  await assertContextDirectory(sourceRoot, workspaceRoot);
  await assertContextDirectory(targetRoot, workspaceRoot);

  const files: string[] = [];
  const directories: string[] = [];
  const scan = async (relative: string): Promise<void> => {
    if (relative === path.join("local", CONTEXT_MIGRATION_STATE))
      throw new Error(
        "legacy context occupies the reserved migration metadata directory",
      );
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    const stat = await fs.lstat(source);
    const existing = await statIfPresent(target);
    if (stat.isDirectory()) {
      if (existing && !existing.isDirectory())
        throw new Error(
          `context migration conflict at ${CONTEXT_DIR}/${relative}: destination is not a directory`,
        );
      // The share API is keyed by id, not path. Do not create ambiguous ids in
      // opposite scopes even when the filenames themselves do not collide.
      const attachment = /^(local|shared)\/attachments\/([^/]+)$/.exec(
        relative.split(path.sep).join("/"),
      );
      if (
        attachment &&
        (await statIfPresent(
          path.join(
            targetRoot,
            attachment[1] === "local" ? "shared" : "local",
            "attachments",
            attachment[2],
          ),
        ))
      ) {
        throw new Error(
          `context migration conflict: attachment ${attachment[2]} exists in the other scope`,
        );
      }
      directories.push(relative);
      for (const entry of await fs.readdir(source))
        await scan(path.join(relative, entry));
    } else if (stat.isFile()) {
      if (
        existing &&
        (!existing.isFile() ||
          (!mergeableIgnoreFile(relative) &&
            !(await identicalFiles(source, target))))
      ) {
        throw new Error(
          `context migration conflict at ${CONTEXT_DIR}/${relative}: different files occupy the same path; resolve them on disk`,
        );
      }
      files.push(relative);
    } else {
      throw new Error(
        "context migration refuses symlinks and non-regular files",
      );
    }
  };
  await scan("");
  for (const relative of directories) {
    const target = path.join(targetRoot, relative);
    await assertContextDirectory(target, workspaceRoot);
    await fs.mkdir(target, { recursive: true });
  }
  // Preserve the visibility of previously shared files. Already-ignored
  // scratch within shared stays ignored; tracked files count as shared even
  // when an ignore rule also matches their old path.
  const sharedFiles = files.filter(
    (relative) =>
      relative.startsWith(`shared${path.sep}`) &&
      path.basename(relative) !== ".gitignore",
  );
  const sourcePaths = sharedFiles.map(
    (relative) => `${LEGACY_CONTEXT_DIR}/${relative.split(path.sep).join("/")}`,
  );
  const sourceIgnores = new Set(
    await ignoredPaths(workspaceRoot, sourcePaths, false),
  );

  // Install ALL incoming ignore rules before testing destination visibility,
  // but keep the legacy copies until every shared file passes. The root and
  // local scaffold rules are merged, not treated as user-file collisions.
  for (const relative of files.filter(
    (file) => path.basename(file) === ".gitignore",
  )) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    await assertContextDirectory(path.dirname(source), workspaceRoot);
    await assertContextDirectory(path.dirname(target), workspaceRoot);
    if (mergeableIgnoreFile(relative)) {
      await appendIgnore(target, await readTextFile(source));
    } else {
      try {
        await fs.link(source, target);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await identicalFiles(source, target))
        )
          throw error;
      }
    }
  }
  const sharedTargets = sharedFiles
    .filter((_relative, index) => !sourceIgnores.has(sourcePaths[index]))
    .map((relative) => `${CONTEXT_DIR}/${relative.split(path.sep).join("/")}`);
  if (sharedTargets.length > 0)
    await exposeSharedContext(workspaceRoot, sharedTargets);
  await recordMigratedRootFiles(workspaceRoot, files);
  for (const relative of files) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    await assertContextDirectory(path.dirname(source), workspaceRoot);
    await assertContextDirectory(path.dirname(target), workspaceRoot);
    try {
      await fs.link(source, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Another process may already have completed this exact move.
      if (code === "ENOENT" && (await statIfPresent(target))) continue;
      if (code !== "EEXIST") throw error;
      if (mergeableIgnoreFile(relative)) {
        await appendIgnore(target, await readTextFile(source));
      } else if (!(await identicalFiles(source, target))) {
        throw new Error(
          `context migration conflict at ${CONTEXT_DIR}/${relative}: destination changed during migration`,
        );
      }
    }
    await retireLegacyContextFile(workspaceRoot, relative, copiedFileMatches);
  }
  for (const relative of directories.reverse()) {
    await fs
      .rmdir(path.join(sourceRoot, relative))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      });
  }
  if (await statIfPresent(sourceRoot)) {
    throw new Error(
      "context changed during migration; preparation will retry on refresh",
    );
  }
  return true;
}

async function ignoredPaths(
  workspaceRoot: string,
  relativePaths: string[],
  noIndex = true,
): Promise<string[]> {
  if (relativePaths.length === 0) return [];
  try {
    const { stdout } = await runFile(
      "git",
      [
        "-C",
        workspaceRoot,
        "check-ignore",
        ...(noIndex ? ["--no-index"] : []),
        "--stdin",
        "-z",
      ],
      { timeoutMs: 5_000, input: `${relativePaths.join("\0")}\0` },
    );
    return stdout.split("\0").filter(Boolean);
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: string };
    if (failure.code === 1 || failure.stderr?.includes("not a git repository"))
      return [];
    throw error;
  }
}

async function ignored(
  workspaceRoot: string,
  relative: string,
): Promise<boolean> {
  try {
    await runFile(
      "git",
      ["-C", workspaceRoot, "check-ignore", "--no-index", "-q", "--", relative],
      { timeoutMs: 5_000 },
    );
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/** Called only for a sharing action or migration of already-shared content.
 * Re-open an ignored parent while keeping every sibling private. Ignore rules
 * inside shared subfolders are user-owned and still take precedence. */
export async function exposeSharedContext(
  workspaceRoot: string,
  targets = [`${CONTEXT_DIR}/shared/attachments/`],
): Promise<void> {
  // Some attachment users are ordinary folders, with no Git checkout at all.
  try {
    await runFile(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--show-toplevel"],
      { timeoutMs: 5_000 },
    );
  } catch (error) {
    if ((error as { stderr?: string }).stderr?.includes("not a git repository"))
      return;
    throw error;
  }
  const root = path.join(workspaceRoot, CONTEXT_DIR);
  await assertContextDirectory(root, workspaceRoot);
  if (await ignored(workspaceRoot, `${CONTEXT_DIR}/`)) {
    await appendIgnore(
      path.join(workspaceRoot, ".gitignore"),
      [
        "# Zeros: share context without publishing private scratch files.",
        "!/.context/",
        "/.context/*",
        "!/.context/shared/",
        "!/.context/shared/**",
        "",
      ].join("\n"),
    );
  }
  if (await ignored(workspaceRoot, `${CONTEXT_DIR}/shared/`)) {
    await appendIgnore(
      path.join(root, ".gitignore"),
      [
        "# Zeros: items explicitly shared from the Context tab.",
        "!/shared/",
        "!/shared/**",
        "",
      ].join("\n"),
    );
  }
  const excluded = await ignoredPaths(workspaceRoot, targets);
  if (excluded.length > 0) {
    throw new Error(
      `shared context is still gitignored at ${excluded[0]}; check repository and .context/shared ignore rules`,
    );
  }
}
