import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { zerosDataDir } from "../db/paths";
import {
  DESIGN_DIRECTORY_ID_PATTERN,
  sanitizeDesignDirectoryName,
} from "./directory-path";

export const DESIGN_DIRECTORY_REGISTRY_FILE = ".zeros/design-dir.toml";
export const DESIGN_METADATA_ROOT = ".zeros/design";
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const portable = (value: string) => value.normalize("NFC").toLowerCase();
export const designDirectoryRegistrySchema = z
  .object({
    version: z.literal(1),
    directories: z
      .record(
        z.string().regex(DESIGN_DIRECTORY_ID_PATTERN),
        z
          .object({
            path: z
              .string()
              .refine(
                (value) => sanitizeDesignDirectoryName(value) === value,
                "Expected a canonical repo-relative directory",
              ),
          })
          .strict(),
      )
      .refine(
        (entries) => Object.keys(entries).length <= 64,
        "Too many Design directories",
      ),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const entries = Object.entries(registry.directories);
    for (let i = 0; i < entries.length; i++)
      for (let j = i + 1; j < entries.length; j++) {
        if (portable(entries[i][0]) === portable(entries[j][0]))
          ctx.addIssue({
            code: "custom",
            message:
              "Design directory IDs must have distinct portable spelling",
            path: ["directories", entries[j][0]],
          });
        const a = portable(entries[i][1].path),
          b = portable(entries[j][1].path);
        if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))
          ctx.addIssue({
            code: "custom",
            message:
              "Design directories must have distinct, non-overlapping paths",
            path: ["directories", entries[j][0], "path"],
          });
      }
  });
export type DesignDirectoryRegistry = z.infer<
  typeof designDirectoryRegistrySchema
>;

export function parseDesignDirectoryRegistry(
  source: string,
): DesignDirectoryRegistry {
  if (Buffer.byteLength(source) > MAX_METADATA_BYTES)
    throw new Error("Design directory registry is too large.");
  return designDirectoryRegistrySchema.parse(parse(source));
}

/** Every segment uses its exact portable spelling and its own inode. This is
 * also used for prospective paths, before creating any parent directories. */
export function assertSafeDesignStoragePath(
  root: string,
  relative: string,
  createParents = false,
): string {
  const parts = relative.split("/");
  if (
    !relative ||
    path.isAbsolute(relative) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        Array.from(part).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error("Unsafe Design storage path.");
  let parent = realpathSync(root);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index],
      candidate = path.join(parent, part);
    const spelling = readdirSync(parent).find(
      (entry) => portable(entry) === portable(part),
    );
    if (spelling !== undefined && spelling !== part)
      throw new Error("Design storage path has ambiguous spelling.");
    let info;
    try {
      info = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info) {
      if (
        info.isSymbolicLink() ||
        realpathSync(candidate) !== candidate ||
        (index < parts.length - 1
          ? !info.isDirectory()
          : !info.isFile() || info.nlink !== 1)
      )
        throw new Error(
          "Design storage must use real directories and unlinked regular files.",
        );
    } else if (index < parts.length - 1) {
      if (createParents) mkdirSync(candidate);
      else return path.join(parent, ...parts.slice(index));
    }
    parent = candidate;
  }
  return parent;
}

export function readDesignStorageFile(
  root: string,
  relative: string,
  limit = MAX_METADATA_BYTES,
): string | null {
  let target: string;
  try {
    target = assertSafeDesignStoragePath(root, relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit)
      throw new Error("Unsafe or oversized Design metadata file.");
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0,
      count = 0;
    do {
      count = readSync(fd, bytes, offset, bytes.length - offset, null);
      offset += count;
    } while (count && offset < bytes.length);
    if (offset !== info.size)
      throw new Error("Design metadata changed during read.");
    const current = lstatSync(target);
    if (
      current.ino !== info.ino ||
      current.dev !== info.dev ||
      current.mtimeMs !== info.mtimeMs ||
      current.nlink !== 1
    )
      throw new Error("Design metadata changed during read.");
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readDesignDirectoryRegistry(
  workspace: string,
): DesignDirectoryRegistry | null {
  const raw = readDesignStorageFile(workspace, DESIGN_DIRECTORY_REGISTRY_FILE);
  return raw === null ? null : parseDesignDirectoryRegistry(raw);
}
/** Resolve against THIS checkout. A missing ID never selects another folder. */
export function legacyDesignDirectoryId(directory: string): string {
  return `design_legacy_${createHash("sha256").update(directory).digest("hex").slice(0, 24)}`;
}
export function designDirectoryFromSettings(
  workspace: string,
  effective: Record<string, unknown>,
  legacyDirectory?: string,
): string | undefined {
  const design = effective.design as
    | { directory?: unknown; directory_id?: unknown }
    | undefined;
  if (!design) return undefined;
  let selected: string | undefined;
  if (design.directory_id !== undefined) {
    if (
      typeof design.directory_id !== "string" ||
      !DESIGN_DIRECTORY_ID_PATTERN.test(design.directory_id)
    )
      throw new Error("Invalid Design directory ID.");
    selected =
      readDesignDirectoryRegistry(workspace)?.directories[design.directory_id]
        ?.path;
    if (
      !selected &&
      legacyDirectory &&
      design.directory_id === legacyDesignDirectoryId(legacyDirectory) &&
      readDesignStorageFile(
        workspace,
        `${legacyDirectory}/.zeros-canvas.json`,
      ) !== null
    )
      selected = legacyDirectory;
    if (!selected)
      throw new Error(
        "The selected Design directory ID is absent from this checkout's .zeros/design-dir.toml.",
      );
  }
  if (design.directory !== undefined) {
    const name = sanitizeDesignDirectoryName(design.directory);
    if (!name)
      throw new Error("Expected a safe repo-relative Design directory.");
    if (selected && name !== selected)
      throw new Error(
        "Design directory and directory_id select different folders.",
      );
    selected = name;
  }
  return selected;
}
export function validateDesignSettings(
  workspace: string | undefined,
  document: Record<string, unknown>,
  legacyDirectory?: string,
): void {
  if (document.design === undefined) return;
  if (
    !document.design ||
    typeof document.design !== "object" ||
    Array.isArray(document.design)
  )
    throw new Error("Design settings must be a table.");
  const design = document.design as Record<string, unknown>;
  if (
    design.directory !== undefined &&
    !sanitizeDesignDirectoryName(design.directory)
  )
    throw new Error("Expected a safe repo-relative Design directory.");
  if (
    design.directory_id !== undefined &&
    (typeof design.directory_id !== "string" ||
      !DESIGN_DIRECTORY_ID_PATTERN.test(design.directory_id))
  )
    throw new Error("Invalid Design directory ID.");
  if (!workspace) return;
  const selected = designDirectoryFromSettings(
    workspace,
    document,
    legacyDirectory,
  );
  if (!selected) return;
  assertSafeDesignStoragePath(workspace, `${selected}/.zeros-validation`);
  for (const [id, entry] of Object.entries(
    readDesignDirectoryRegistry(workspace)?.directories ?? {},
  )) {
    if (entry.path === selected)
      assertSafeDesignStoragePath(workspace, designDocumentRelativePath(id));
    else if (
      portable(selected).startsWith(portable(entry.path) + "/") ||
      portable(entry.path).startsWith(portable(selected) + "/") ||
      portable(selected) === portable(entry.path)
    )
      throw new Error(
        "The selected Design path overlaps a registered Design directory.",
      );
  }
}
export function designDirectoryEntry(
  workspace: string,
  directory: string,
): { id: string; path: string } | undefined {
  const registry = readDesignDirectoryRegistry(workspace);
  const entry = Object.entries(registry?.directories ?? {}).find(
    ([, value]) => value.path === directory,
  );
  return entry ? { id: entry[0], path: entry[1].path } : undefined;
}
export function designDocumentRelativePath(id: string): string {
  if (!DESIGN_DIRECTORY_ID_PATTERN.test(id))
    throw new Error("Invalid Design directory ID.");
  return `${DESIGN_METADATA_ROOT}/${id}/document.json`;
}
/** Read compatibility only: new writes always register and use document.json. */
export function designDocumentMetadataPath(
  workspace: string,
  directory: string,
): string {
  const entry = designDirectoryEntry(workspace, directory);
  return path.join(
    workspace,
    entry
      ? designDocumentRelativePath(entry.id)
      : `${directory}/.zeros-canvas.json`,
  );
}
export function designMetadataGitPaths(
  workspace: string,
  directory?: string,
): string[] {
  const registry = readDesignDirectoryRegistry(workspace);
  if (!registry) return [];
  const entries = Object.entries(registry.directories).filter(
    ([, entry]) => !directory || entry.path === directory,
  );
  return entries.length
    ? [
        DESIGN_DIRECTORY_REGISTRY_FILE,
        ...entries.map(([id]) => designDocumentRelativePath(id)),
      ]
    : [];
}
export function isDesignMetadataRepoPath(file: string): boolean {
  return (
    portable(file) === portable(DESIGN_DIRECTORY_REGISTRY_FILE) ||
    /^\.zeros\/design\/design_[a-zA-Z0-9_-]{1,64}\/document\.json$/i.test(file)
  );
}

export function designPrivateStorageDirectory(workspace: string): string {
  const key = createHash("sha256")
    .update(path.resolve(workspace))
    .digest("hex")
    .slice(0, 32);
  return path.join(zerosDataDir(), "design-storage", key);
}
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function atomicWrite(root: string, relative: string, source: string): void {
  const target = assertSafeDesignStoragePath(root, relative, true);
  const temporary = `${target}.${randomUUID()}.zeros-tmp`;
  const fd = openSync(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, source, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    assertSafeDesignStoragePath(root, relative);
    renameSync(temporary, target);
    syncDirectory(path.dirname(target));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function writePrivateDesignState(
  workspace: string,
  name: string,
  source: string,
): string {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(name))
    throw new Error("Invalid private Design state name.");
  const root = designPrivateStorageDirectory(workspace);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  atomicWrite(root, name, source);
  return path.join(root, name);
}
export interface DesignStorageChange {
  file: string;
  before: string | null;
  after: string | null;
}
export interface DesignMetadataSnapshot {
  registry: string | null;
  file: string;
  source: string | null;
}
const storageChangeSchema = z
  .object({
    file: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
  })
  .strict();
const migrationSchema = z
  .object({
    version: z.literal(1),
    workspace: z.string(),
    directory: z.string(),
    changes: z.array(storageChangeSchema).max(2052),
  })
  .strict();
const journalName = (directory: string) =>
  `metadata-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}.json`;

function applyStorageChanges(
  workspace: string,
  directory: string,
  changes: DesignStorageChange[],
): void {
  if (new Set(changes.map((change) => change.file)).size !== changes.length)
    throw new Error("Design storage transaction contains duplicate paths.");
  for (const change of changes) {
    if (
      !isDesignMetadataRepoPath(change.file) &&
      change.file !== `${directory}/.zeros-canvas.json` &&
      !change.file.startsWith(`${directory}/`)
    )
      throw new Error("Design migration contains an unsupported path.");
    const current = readDesignStorageFile(workspace, change.file);
    if (current !== change.before && current !== change.after)
      throw new Error(
        "Design metadata or source changed during migration. Review the retained recovery record before retrying.",
      );
  }
  for (const change of changes) {
    if (readDesignStorageFile(workspace, change.file) === change.after)
      continue;
    if (change.after === null) {
      const target = assertSafeDesignStoragePath(workspace, change.file);
      unlinkSync(target);
      syncDirectory(path.dirname(target));
    } else atomicWrite(workspace, change.file, change.after);
  }
}
/** Lifecycle snapshots must include the completed source/metadata pair, even
 * when the engine restarted in the middle of a prior Design save. */
export function recoverWorkspaceDesignMetadata(workspace: string): void {
  recoverDesignDirectoryRename(workspace);
  const root = designPrivateStorageDirectory(workspace);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root).filter((file) =>
    /^metadata-[a-f0-9]{24}\.json$/.test(file),
  )) {
    const source = readDesignStorageFile(root, name, MAX_JOURNAL_BYTES);
    if (source === null) continue;
    const journal = migrationSchema.parse(JSON.parse(source));
    if (journalName(journal.directory) !== name)
      throw new Error("Invalid Design recovery record identity.");
    recoverDesignMetadataMigration(workspace, journal.directory);
  }
}
export function recoverDesignMetadataMigration(
  workspace: string,
  directory: string,
): void {
  const root = designPrivateStorageDirectory(workspace),
    name = journalName(directory);
  if (!existsSync(root)) return;
  const raw = readDesignStorageFile(root, name, MAX_JOURNAL_BYTES);
  if (raw === null) return;
  const journal = migrationSchema.parse(JSON.parse(raw));
  if (
    journal.workspace !== path.resolve(workspace) ||
    journal.directory !== directory ||
    !sanitizeDesignDirectoryName(directory)
  )
    throw new Error("Design migration belongs to another document.");
  applyStorageChanges(workspace, directory, journal.changes);
  unlinkSync(path.join(root, name));
  syncDirectory(root);
}

/** Called only while holding the Design document mutation lane. Write a
 * recoverable, compare-before-replace transaction, with legacy deletion last. */
export function commitDesignMetadata(
  workspace: string,
  directory: string,
  document: string,
  sourceChanges: DesignStorageChange[] = [],
  expected?: DesignMetadataSnapshot,
): string[] {
  if (sanitizeDesignDirectoryName(directory) !== directory)
    throw new Error("Invalid Design directory.");
  recoverDesignMetadataMigration(workspace, directory);
  const registryBefore = readDesignStorageFile(
    workspace,
    DESIGN_DIRECTORY_REGISTRY_FILE,
  );
  if (
    expected &&
    (registryBefore !== expected.registry ||
      readDesignStorageFile(workspace, expected.file) !== expected.source)
  )
    throw new Error(
      "Design metadata changed while this edit was being prepared. Refresh before retrying.",
    );
  const registry =
    registryBefore === null
      ? {
          version: 1 as const,
          directories: {} as DesignDirectoryRegistry["directories"],
        }
      : parseDesignDirectoryRegistry(registryBefore);
  const existing = Object.entries(registry.directories).find(
    ([, entry]) => entry.path === directory,
  );
  const legacy = `${directory}/.zeros-canvas.json`,
    legacyBefore = readDesignStorageFile(workspace, legacy);
  // The same legacy document on older branches migrates to the same ID. New
  // documents get a UUID; either identity stays stable across future renames.
  const id =
    existing?.[0] ??
    (legacyBefore !== null
      ? legacyDesignDirectoryId(directory)
      : `design_${randomUUID().replace(/-/g, "")}`);
  if (!existing && registry.directories[id])
    throw new Error(
      "A legacy Design directory conflicts with an existing identity.",
    );
  registry.directories[id] = { path: directory };
  designDirectoryRegistrySchema.parse(registry);
  const metadata = designDocumentRelativePath(id),
    before = readDesignStorageFile(workspace, metadata);
  if (before !== null && legacyBefore !== null)
    throw new Error(
      "Both legacy and registered Design metadata exist. Resolve the conflict before editing this document.",
    );
  const changes: DesignStorageChange[] = [
    { file: metadata, before, after: document },
    ...(!existing
      ? [
          {
            file: DESIGN_DIRECTORY_REGISTRY_FILE,
            before: registryBefore,
            after: stringify(registry) + "\n",
          },
        ]
      : []),
    ...sourceChanges,
    ...(legacyBefore === null
      ? []
      : [{ file: legacy, before: legacyBefore, after: null }]),
  ].filter((change) => change.before !== change.after);
  if (!changes.length) return [];
  if (
    changes.length > 2052 ||
    new Set(changes.map((change) => change.file)).size !== changes.length
  )
    throw new Error("Invalid Design storage transaction paths.");
  // Validate the entire transaction before journaling or creating parents.
  for (const change of changes) {
    if (readDesignStorageFile(workspace, change.file) !== change.before)
      throw new Error("Design source changed during migration.");
    if (
      change.after !== null &&
      Buffer.byteLength(change.after) > MAX_METADATA_BYTES
    )
      throw new Error("Design metadata exceeds its size limit.");
  }
  const source = JSON.stringify({
    version: 1,
    workspace: path.resolve(workspace),
    directory,
    changes,
  });
  if (Buffer.byteLength(source) > MAX_JOURNAL_BYTES)
    throw new Error("Design metadata migration is too large.");
  const journal = writePrivateDesignState(
    workspace,
    journalName(directory),
    source,
  );
  applyStorageChanges(workspace, directory, changes);
  unlinkSync(journal);
  syncDirectory(path.dirname(journal));
  return changes.map((change) => change.file);
}

const directoryRenameSchema = z
  .object({
    version: z.literal(1),
    from: z.string(),
    to: z.string(),
    before: z.string(),
    after: z.string(),
  })
  .strict();
/** Record the registry half before the Design API moves a source directory.
 * Metadata filenames use the ID, so a rename never moves document.json. */
export function prepareDesignDirectoryRename(
  workspace: string,
  from: string,
  to: string,
): string {
  if (!sanitizeDesignDirectoryName(from) || !sanitizeDesignDirectoryName(to))
    throw new Error("Invalid Design directory rename.");
  assertSafeDesignStoragePath(workspace, `${from}/.zeros-validation`);
  assertSafeDesignStoragePath(workspace, `${to}/.zeros-validation`);
  const before = readDesignStorageFile(
    workspace,
    DESIGN_DIRECTORY_REGISTRY_FILE,
  );
  if (before === null)
    throw new Error("Register the Design directory before renaming it.");
  const registry = parseDesignDirectoryRegistry(before);
  const entry = Object.entries(registry.directories).find(
    ([, value]) => value.path === from,
  );
  if (!entry) throw new Error("The source Design directory is not registered.");
  registry.directories[entry[0]].path = to;
  designDirectoryRegistrySchema.parse(registry);
  writePrivateDesignState(
    workspace,
    "directory-rename.json",
    JSON.stringify({
      version: 1,
      from,
      to,
      before,
      after: stringify(registry) + "\n",
    }),
  );
  return entry[0];
}
/** Finish only a recorded source move; never move or overwrite a competing
 * directory. Used on explicit Design entry after an interrupted rename. */
export function recoverDesignDirectoryRename(workspace: string): void {
  const privateRoot = designPrivateStorageDirectory(workspace);
  if (!existsSync(privateRoot)) return;
  const source = readDesignStorageFile(privateRoot, "directory-rename.json");
  if (source === null) return;
  const record = directoryRenameSchema.parse(JSON.parse(source));
  if (
    !sanitizeDesignDirectoryName(record.from) ||
    !sanitizeDesignDirectoryName(record.to)
  )
    throw new Error("Unsafe Design rename recovery record.");
  const before = parseDesignDirectoryRegistry(record.before),
    after = parseDesignDirectoryRegistry(record.after);
  const entry = Object.entries(before.directories).find(
    ([, value]) => value.path === record.from,
  );
  if (!entry || after.directories[entry[0]]?.path !== record.to)
    throw new Error("Invalid Design rename identity.");
  const expected = structuredClone(before);
  expected.directories[entry[0]].path = record.to;
  if (JSON.stringify(expected) !== JSON.stringify(after))
    throw new Error(
      "Design rename recovery changes unrelated directory identities.",
    );
  const fromExists = existsSync(path.join(workspace, record.from)),
    toExists = existsSync(path.join(workspace, record.to));
  if (fromExists && !toExists) {
    if (
      readDesignStorageFile(workspace, DESIGN_DIRECTORY_REGISTRY_FILE) !==
      record.before
    )
      throw new Error("The registry changed during Design rename recovery.");
  } else if (!fromExists && toExists) {
    assertSafeDesignStoragePath(workspace, `${record.to}/.zeros-validation`);
    applyStorageChanges(workspace, record.to, [
      {
        file: DESIGN_DIRECTORY_REGISTRY_FILE,
        before: record.before,
        after: record.after,
      },
    ]);
  } else
    throw new Error(
      "Design rename recovery found competing or missing directories. Review both paths before retrying.",
    );
  unlinkSync(path.join(privateRoot, "directory-rename.json"));
  syncDirectory(privateRoot);
}
