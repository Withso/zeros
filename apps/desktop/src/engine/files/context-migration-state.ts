// Write recovery records before retiring files; archive/restore preserves populated records with the local scope.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  assertContextDirectory,
  CONTEXT_DIR,
  LEGACY_CONTEXT_DIR,
  statIfPresent,
} from "./context-paths";

export const CONTEXT_MIGRATION_STATE = ".zeros-context-migration";
const STATE_PATH = `${CONTEXT_DIR}/local/${CONTEXT_MIGRATION_STATE}`;

type CopiedFileMatches = (
  source: string,
  target: string,
  relative: string,
) => Promise<boolean>;

function validRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith(`..${path.sep}`)
  );
}

async function readRecord(file: string): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384)
      throw new Error("invalid context migration record");
    const record = JSON.parse(await handle.readFile("utf8")) as {
      version?: unknown;
      path?: unknown;
    };
    if (record?.version !== 1 || !validRelativePath(record.path))
      throw new Error("invalid context migration record");
    return record.path;
  } finally {
    await handle.close();
  }
}

async function stateDirectory(
  workspaceRoot: string,
  child: string,
): Promise<string> {
  const root = path.join(workspaceRoot, STATE_PATH);
  const directory = path.join(root, child);
  await assertContextDirectory(directory, workspaceRoot);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(path.join(root, ".gitignore"), "*\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return directory;
}

function recordBody(relative: string): string {
  return JSON.stringify({ version: 1, path: relative });
}

/** Record exact migrated paths rather than granting archive eligibility to their parent folders. */
export async function recordMigratedRootFiles(
  workspaceRoot: string,
  files: string[],
): Promise<void> {
  const extras = files.filter(
    (relative) =>
      relative !== ".gitignore" &&
      !relative.startsWith(`local${path.sep}`) &&
      !relative.startsWith(`shared${path.sep}`),
  );
  if (extras.length === 0) return;
  const directory = await stateDirectory(workspaceRoot, "archive-paths");
  for (const relative of extras) {
    const digest = createHash("sha256").update(relative).digest("hex");
    const record = path.join(directory, `${digest}.json`);
    try {
      await fs.writeFile(record, recordBody(relative), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await readRecord(record)) !== relative
      )
        throw error;
    }
  }
}

async function entries(workspaceRoot: string, child: string) {
  const directory = path.join(workspaceRoot, STATE_PATH, child);
  await assertContextDirectory(directory, workspaceRoot);
  const names = await fs
    .readdir(directory)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  return names.map((name) => path.join(directory, name));
}

async function removeEmptyRecovery(directory: string): Promise<void> {
  if (await statIfPresent(path.join(directory, "file"))) return;
  await fs
    .unlink(path.join(directory, "record.json"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
}

async function finishRetirement(
  workspaceRoot: string,
  directory: string,
  relative: string,
  matches: CopiedFileMatches,
): Promise<void> {
  const retired = path.join(directory, "file");
  if (!(await statIfPresent(retired))) return;
  const target = path.join(workspaceRoot, CONTEXT_DIR, relative);
  await assertContextDirectory(path.dirname(target), workspaceRoot);
  if (!(await matches(retired, target, relative))) {
    // Restore via an exclusive link so a concurrent save at the old name is never overwritten.
    const source = path.join(workspaceRoot, LEGACY_CONTEXT_DIR, relative);
    await assertContextDirectory(path.dirname(source), workspaceRoot);
    await fs.mkdir(path.dirname(source), { recursive: true });
    let recovery: string | undefined;
    try {
      await fs.link(retired, source);
      await fs.unlink(retired);
      await removeEmptyRecovery(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // If both names changed, preserve the captured version in the archiveable recovery record.
      recovery = path.relative(workspaceRoot, retired);
    }
    throw new Error(
      `context changed during migration; resolve ${LEGACY_CONTEXT_DIR}/${relative} and ${CONTEXT_DIR}/${relative} on disk${recovery ? ` (captured copy: ${recovery})` : ""}`,
    );
  }
  // Only unlink the claimed recovery file; a later save at the legacy name belongs to the next migration.
  await fs.unlink(retired).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await removeEmptyRecovery(directory);
}

/** Claim the source atomically so retirement cannot unlink a concurrent save at its old path. */
export async function retireLegacyContextFile(
  workspaceRoot: string,
  relative: string,
  matches: CopiedFileMatches,
): Promise<void> {
  const parent = await stateDirectory(workspaceRoot, "recovery");
  const directory = await fs.mkdtemp(path.join(parent, "move-"));
  await fs.writeFile(
    path.join(directory, "record.json"),
    recordBody(relative),
    { flag: "wx", mode: 0o600 },
  );
  const source = path.join(workspaceRoot, LEGACY_CONTEXT_DIR, relative);
  await assertContextDirectory(path.dirname(source), workspaceRoot);
  try {
    await fs.rename(source, path.join(directory, "file"));
  } catch (error) {
    await removeEmptyRecovery(directory);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await finishRetirement(workspaceRoot, directory, relative, matches);
}

/** Finish any interrupted retirement before scanning the legacy root. */
export async function recoverContextMigration(
  workspaceRoot: string,
  matches: CopiedFileMatches,
): Promise<boolean> {
  let recovered = false;
  for (const directory of await entries(workspaceRoot, "recovery")) {
    await assertContextDirectory(directory, workspaceRoot);
    // A record without data may belong to a live writer; leave it alone.
    if (!(await statIfPresent(path.join(directory, "file")))) continue;
    const relative = await readRecord(path.join(directory, "record.json"));
    await finishRetirement(workspaceRoot, directory, relative, matches);
    recovered = true;
  }
  return recovered;
}

export async function contextMigrationArchivePaths(
  workspaceRoot: string,
): Promise<string[]> {
  const paths: string[] = [];
  let preserveState = false;
  for (const record of await entries(workspaceRoot, "archive-paths")) {
    const relative = await readRecord(record);
    const target = path.join(workspaceRoot, CONTEXT_DIR, relative);
    await assertContextDirectory(path.dirname(target), workspaceRoot);
    const stat = await statIfPresent(target);
    if (stat?.isDirectory())
      throw new Error("a migrated context file was replaced by a directory");
    if (stat)
      paths.push(`${CONTEXT_DIR}/${relative.split(path.sep).join("/")}`);
    preserveState = true;
  }
  for (const directory of await entries(workspaceRoot, "recovery")) {
    await assertContextDirectory(directory, workspaceRoot);
    if (await statIfPresent(path.join(directory, "file"))) preserveState = true;
  }
  if (preserveState) paths.push(STATE_PATH);
  return paths;
}
