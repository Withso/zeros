import {
  assertSafeDesignStoragePath,
  readDesignStorageFile,
  designPrivateStorageDirectory,
  writePrivateDesignState,
  atomicWriteDesignStorageFile as atomicWrite,
  syncDesignStorageDirectory as syncDirectory,
} from "./metadata-storage";
import { GENERATED_DESIGN_RULES, upgradedDesignRules } from "./design-rules";
import { createDesignPagesLayout, designPagesMigrationOwnsManifests, migrateDesignDirectoryPages, recoverDesignPagesMigration, recoverWorkspaceDesignPagesMigrations, type DesignPagesMigrationOptions } from "./pages-migration";
export { assertSafeDesignStoragePath, readDesignStorageFile, designPrivateStorageDirectory, writePrivateDesignState } from "./metadata-storage";
export { DESIGN_RULES, ROOT_DESIGN_RULES, LEGACY_DESIGN_RULES, PREVIOUS_NATIVE_DESIGN_RULES } from "./design-rules";
import { createHash, randomUUID } from "node:crypto";
import { assertDesignWriteAuthorized } from "./write-authority";
import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { parse as parseHtml } from "parse5";
import { nextFrameGeometry, readFrameMeta } from "./frame-metadata";
import type { CanvasDocument } from "./document-model";
import {
  DESIGN_MANIFEST_FILE,
  parseDesignManifest,
  serializeDesignRegistration,
} from "./manifest";
import { DESIGN_CANVAS_FILE, decodeCanvasFile, encodeCanvasFile } from "./canvas-file";
import { resolveDesignManifestLayout } from "./layout";
import { isDesignFrameFile } from "@zeros/protocol/design-path";
import {
  assertDesignFilesNotIgnored,
  designGitignoreSource,
} from "./gitignore";
import {
  DESIGN_DIRECTORY_ID_PATTERN,
  sanitizeDesignDirectoryName,
} from "./directory-path";

/** Legacy central locations remain readable and protected during migration. */
export const DESIGN_METADATA_ROOT = ".zeros/design";
export const DESIGN_DIRECTORY_REGISTRY_FILE = `${DESIGN_METADATA_ROOT}/design.toml`;
export const LEGACY_DESIGN_DIRECTORY_REGISTRY_FILE = ".zeros/design-dir.toml";
export const DESIGN_DIRECTORY_REGISTRY_FILES = [
  DESIGN_DIRECTORY_REGISTRY_FILE,
  `${DESIGN_METADATA_ROOT}/design-dir.toml`,
  LEGACY_DESIGN_DIRECTORY_REGISTRY_FILE,
] as const;
export const DESIGN_METADATA_PROTECTED_PATHS = [
  DESIGN_METADATA_ROOT,
  LEGACY_DESIGN_DIRECTORY_REGISTRY_FILE,
] as const;
export const DESIGN_RULES_FILE = `${DESIGN_METADATA_ROOT}/rules.md`;
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

// Cache only discovery candidates, never metadata bytes. Watchers invalidate
// on manifest/ancestor changes; explicit entry/listing refreshes the scan.
function designDiscoveryKey(workspace: string): string {
  try {
    return realpathSync(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return path.resolve(workspace);
    throw error;
  }
}
const manifestCandidates = new Map<string, Set<string>>();
export function invalidateDesignManifestDiscovery(workspace: string): void {
  manifestCandidates.delete(designDiscoveryKey(workspace));
}
export function refreshDesignManifestDiscovery(workspace: string): void {
  const directories = new Set<string>();
  const pending = [""];
  let visited = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    if (++visited > 20_000)
      throw new Error("Design discovery exceeded its directory limit.");
    let entries;
    try {
      entries = readdirSync(path.join(workspace, relative), {
        withFileTypes: true,
      });
    } catch (error) {
      // A missing attached context root, or a directory removed during this
      // scan, contains no live manifest. Other inspection failures stay closed.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (relative && entries.some((entry) => entry.name === ".git")) continue;
    if (
      relative &&
      entries.some((entry) => entry.name === DESIGN_MANIFEST_FILE)
    )
      directories.add(`${relative}/${DESIGN_MANIFEST_FILE}`);
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        [
          ".git",
          ".zeros",
          ".context",
          ".context-graph",
          ".zeros-dev",
          "node_modules",
        ].includes(entry.name)
      )
        continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (sanitizeDesignDirectoryName(next) === next) pending.push(next);
    }
  }
  const key = designDiscoveryKey(workspace);
  manifestCandidates.delete(key);
  manifestCandidates.set(key, directories);
  if (manifestCandidates.size > 128)
    manifestCandidates.delete(manifestCandidates.keys().next().value!);
}
function rememberManifest(workspace: string, directory: string): void {
  const key = designDiscoveryKey(workspace);
  if (!manifestCandidates.has(key)) refreshDesignManifestDiscovery(workspace);
  manifestCandidates.get(key)!.add(readDirectoryDesignLayout(workspace, directory)?.manifestFile ?? `${directory}/${DESIGN_MANIFEST_FILE}`);
}
export function readDirectoryDesignLayout(
  workspace: string,
  directory: string,
) {
  const rootFile = `${directory}/${DESIGN_MANIFEST_FILE}`;
  const sources = [{ file: rootFile, source: readDesignStorageFile(workspace, rootFile) }];
  // A legacy root may have an unrelated file called meta. It cannot contain a
  // registration; leave that collision to explicit v3 migration preflight.
  const metaEntries = (() => {
    try {
      return readdirSync(path.join(workspace, directory), { withFileTypes: true })
        .filter((entry) => portable(entry.name) === "meta");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  })();
  for (const meta of metaEntries) {
    if (meta.isFile()) continue;
    const file = `${directory}/${meta.name}/${DESIGN_MANIFEST_FILE}`;
    sources.push({ file, source: readDesignStorageFile(workspace, file) });
  }
  const layouts = sources.flatMap(({ file, source }) => {
    const manifest = source === null ? null : parseDesignManifest(source);
    if (!manifest) return [];
    const layout = resolveDesignManifestLayout(file, manifest);
    if (layout.directory !== directory)
      throw new Error("The Design manifest belongs to a different directory layout.");
    return [{ ...layout, manifest }];
  });
  if (layouts.length > 1) {
    const root = layouts.find(layout => layout.kind === "root-v2");
    const meta = layouts.find(layout => layout.kind === "meta-v3");
    if (root && meta && root.manifest.id === meta.manifest.id &&
        designPagesMigrationOwnsManifests(workspace, directory,
          sources.find(source => source.file === root.manifestFile)!.source!,
          sources.find(source => source.file === meta.manifestFile)!.source!))
      return meta;
    throw new Error("Competing root and meta Design manifests exist. Resolve both registrations before editing.");
  }
  return layouts[0] ?? null;
}
export function readDirectoryDesignManifest(workspace: string, directory: string) {
  return readDirectoryDesignLayout(workspace, directory)?.manifest ?? null;
}
export function readDesignDirectoryRegistry(
  workspace: string,
): DesignDirectoryRegistry | null {
  const raw = readDesignRegistrySource(workspace).source;
  const registry =
    raw === null
      ? {
          version: 1 as const,
          directories: {} as DesignDirectoryRegistry["directories"],
        }
      : parseDesignDirectoryRegistry(raw);
  const key = designDiscoveryKey(workspace);
  if (!manifestCandidates.has(key)) refreshDesignManifestDiscovery(workspace);
  // A move can be observed before the watcher event reaches the engine.
  if (
    [...manifestCandidates.get(key)!].some(
      (file) => !existsSync(path.dirname(path.join(workspace, file))),
    )
  )
    refreshDesignManifestDiscovery(workspace);
  for (const file of manifestCandidates.get(key)!) {
    const source = readDesignStorageFile(workspace, file);
    const candidate = source === null ? null : parseDesignManifest(source);
    if (!candidate) continue;
    const { directory } = resolveDesignManifestLayout(file, candidate);
    const manifest = readDirectoryDesignManifest(workspace, directory)!;
    const existing = registry.directories[manifest.id];
    if (existing && existing.path !== directory)
      throw new Error(
        "Multiple Design folders have the same ID. Resolve the duplicate before editing.",
      );
    registry.directories[manifest.id] = { path: directory };
  }
  return Object.keys(registry.directories).length
    ? designDirectoryRegistrySchema.parse(registry)
    : null;
}

/** Reads never migrate. Older branches keep their own registry and IDs. */
export function readDesignRegistrySource(workspace: string): {
  file: string;
  source: string | null;
} {
  const snapshots = DESIGN_DIRECTORY_REGISTRY_FILES.map((file) => ({
    file,
    source: readDesignStorageFile(workspace, file),
  })).filter((snapshot) => snapshot.source !== null);
  if (snapshots.length > 1)
    throw new Error(
      "Multiple Design registries exist. Resolve the competing registries before editing.",
    );
  return snapshots[0] ?? { file: DESIGN_DIRECTORY_REGISTRY_FILE, source: null };
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
        "The selected Design directory ID is absent from this checkout. Choose an available Design folder in Settings.",
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
      designDocumentMetadataRelativePath(workspace, id);
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
  if (readDirectoryDesignManifest(workspace, directory))
    rememberManifest(workspace, directory);
  const registry = readDesignDirectoryRegistry(workspace);
  const entry = Object.entries(registry?.directories ?? {}).find(
    ([, value]) => value.path === directory,
  );
  return entry ? { id: entry[0], path: entry[1].path } : undefined;
}
export function designDocumentMetadataDirectory(id: string): string {
  if (!DESIGN_DIRECTORY_ID_PATTERN.test(id))
    throw new Error("Invalid Design directory ID.");
  return `${DESIGN_METADATA_ROOT}/${id}`;
}
export function designDocumentRelativePath(id: string): string {
  return `${designDocumentMetadataDirectory(id)}/metadata.json`;
}

function designDocumentMetadataRelativePath(
  workspace: string,
  id: string,
): string {
  const canonical = designDocumentRelativePath(id);
  const candidates = [
    canonical,
    `${designDocumentMetadataDirectory(id)}/document.json`,
  ];
  const existing = candidates.filter((file) =>
    existsSync(assertSafeDesignStoragePath(workspace, file)),
  );
  if (existing.length > 1)
    throw new Error(
      "Both metadata.json and document.json exist. Resolve the competing Design metadata before editing.",
    );
  return existing[0] ?? canonical;
}

/** Canonical metadata travels with its source; central JSON is read compatibility. */
export function designDocumentMetadataPath(
  workspace: string,
  directory: string,
): string {
  const layout = readDirectoryDesignLayout(workspace, directory);
  const manifest = layout?.manifest;
  const entry = designDirectoryEntry(workspace, directory);
  if (manifest) {
    if (
      readDesignStorageFile(
        workspace,
        designDocumentMetadataRelativePath(workspace, manifest.id),
      ) !== null
    )
      throw new Error(
        "Both legacy and registered Design metadata exist. Resolve the conflict before editing.",
      );
    return path.join(workspace, layout!.documentFile);
  }
  return path.join(
    workspace,
    entry
      ? designDocumentMetadataRelativePath(workspace, entry.id)
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
        readDesignRegistrySource(workspace).file,
        DESIGN_RULES_FILE,
        // Scope Git to the selected document's folder so migrations stage
        // both the new filename and the deletion of its tracked predecessor.
        ...entries.map(([id]) => designDocumentMetadataDirectory(id)),
      ]
    : [];
}
export function isDesignMetadataRepoPath(file: string): boolean {
  const normalized = portable(
    path.posix.normalize(file.replace(/\\/g, "/")),
  ).replace(/\/+$/, "");
  return (
    normalized === DESIGN_METADATA_ROOT ||
    normalized.startsWith(`${DESIGN_METADATA_ROOT}/`) ||
    normalized === LEGACY_DESIGN_DIRECTORY_REGISTRY_FILE
  );
}

/** Preserve the complete document while migrating its storage envelope. */
export function ensureDesignMetadataLayout(
  workspace: string,
  directory: string,
): string[] {
  // A current canvas is agent-authored input, not a normalization job. Only
  // recognized generated guidance is upgraded in this authoring lifecycle.
  recoverDesignMetadataMigration(workspace, directory);
  const layout = readDirectoryDesignLayout(workspace, directory);
  if (layout?.manifest.canvas) {
    const file = `${directory}/rules.md`;
    const before = readDesignStorageFile(workspace, file);
    const after = upgradedDesignRules(before, layout.canvasVersion);
    if (before === after) return [];
    assertDesignWriteAuthorized();
    if (Buffer.byteLength(after) > MAX_METADATA_BYTES)
      throw new Error("Design rules exceed the metadata size limit.");
    const changes = [{ file, before, after }];
    const journal = writePrivateDesignState(
      workspace,
      journalName(directory),
      JSON.stringify({ version: 1, workspace: path.resolve(workspace), directory, changes }),
    );
    applyStorageChanges(workspace, directory, changes);
    unlinkSync(journal);
    syncDirectory(path.dirname(journal));
    return [file];
  }
  const registry = readDesignRegistrySource(workspace);
  if (!designDirectoryEntry(workspace, directory)) return [];
  const file = path
    .relative(workspace, designDocumentMetadataPath(workspace, directory))
    .split(path.sep)
    .join("/");
  const source = readDesignStorageFile(workspace, file);
  if (source === null)
    throw new Error("The registered Design document metadata is missing.");
  const document = file.endsWith(`/${DESIGN_MANIFEST_FILE}`)
    ? JSON.stringify(parseDesignManifest(source)!.document)
    : file.endsWith(`/${DESIGN_CANVAS_FILE}`)
      ? JSON.stringify(decodeCanvasFile(source))
      : source;
  return commitDesignMetadata(workspace, directory, document, [], {
    registry: registry.source,
    registryFile: registry.file,
    file,
    source,
  });
}

/** Explicit authoring only. Keep the legacy all-entries upgrade unchanged,
 * then upgrade exactly the requested v2 root to the paged layout. */
export function ensureDesignPagesLayout(workspace: string, directory: string): string[] {
  const recovered = recoverDesignPagesMigration(workspace, directory);
  if (recovered.length) invalidateDesignManifestDiscovery(workspace);
  const legacy = ensureDesignMetadataLayout(workspace, directory);
  const directories = Object.values(readDesignDirectoryRegistry(workspace)?.directories ?? {}).map(entry => entry.path);
  const migrated = migrateDesignDirectoryPages(workspace, directory, { directories });
  if (migrated.length) invalidateDesignManifestDiscovery(workspace);
  return [...recovered, ...legacy, ...migrated];
}

/** Fresh lifecycle creation keeps the same registration identity, overlap and
 * directory-budget checks as legacy commitDesignMetadata. No source is written
 * until the authoritative catalog accepts the prospective registration. */
export function createDesignDirectoryPages(
  workspace: string,
  directory: string,
  document: Record<string, unknown>,
  options: DesignPagesMigrationOptions & { id?: string; preservedCanvas?: string } = {},
): string[] {
  assertDesignWriteAuthorized();
  if (sanitizeDesignDirectoryName(directory) !== directory)
    throw new Error("Invalid Design directory.");
  refreshDesignManifestDiscovery(workspace);
  const registry = readDesignDirectoryRegistry(workspace) ?? { version: 1 as const, directories: {} };
  const existing = Object.entries(registry.directories).find(([, entry]) => entry.path === directory);
  const id = options.id ?? existing?.[0] ?? `design_${randomUUID().replace(/-/g, "")}`;
  if (!DESIGN_DIRECTORY_ID_PATTERN.test(id) || (existing && existing[0] !== id))
    throw new Error("The restored Design identity conflicts with this folder.");
  if (registry.directories[id] && registry.directories[id].path !== directory)
    throw new Error("A Design directory conflicts with an existing identity.");
  registry.directories[id] = { path: directory };
  designDirectoryRegistrySchema.parse(registry);
  const created = createDesignPagesLayout(workspace, directory, document, {
    ...options,
    id,
    directories: Object.values(registry.directories).map((entry) => entry.path),
  });
  invalidateDesignManifestDiscovery(workspace);
  return created;
}

export interface DesignStorageChange {
  file: string;
  before: string | null;
  after: string | null;
}
export interface DesignMetadataSnapshot {
  registry: string | null;
  registryFile?: string;
  file: string;
  source: string | null;
  registration?: { file: string; source: string | null };
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
// Compatibility only: experimental builds could move authored files out of the
// checkout. Never erase that ownership marker or silently fall back to writes.
const privateDraftFenceName = journalName("private-draft-migration");
const privateDraftFenceSchema = z.object({ version: z.literal(2), workspace: z.string(), directory: z.literal("private-draft-migration"), owner: z.string().min(1).max(128) }).strict();
export function assertLegacyDesignDraftWritable(workspace: string): void {
  const source = readDesignStorageFile(designPrivateStorageDirectory(workspace), privateDraftFenceName);
  if (source !== null) {
    privateDraftFenceSchema.parse(JSON.parse(source));
    throw new Error("This workspace has a retired private Design draft. Preserve its data and use a recovery-capable build to export it before editing the checkout.");
  }
}

function applyStorageChanges(
  workspace: string,
  directory: string,
  changes: DesignStorageChange[],
): void {
  if (new Set(changes.map((change) => change.file)).size !== changes.length)
    throw new Error("Design storage transaction contains duplicate paths.");
  const migrationDirectories = new Set<string>();
  for (const change of changes) {
    if (
      DESIGN_DIRECTORY_REGISTRY_FILES.some((file) => file === change.file) &&
      change.before !== null
    ) {
      for (const entry of Object.values(
        parseDesignDirectoryRegistry(change.before).directories,
      ))
        migrationDirectories.add(entry.path);
    }
  }
  for (const change of changes) {
    if (
      !DESIGN_DIRECTORY_REGISTRY_FILES.some((file) => file === change.file) &&
      change.file !== DESIGN_RULES_FILE &&
      !/^\.zeros\/design\/design_[a-zA-Z0-9_-]{1,64}\/(?:metadata|document)\.json$/.test(
        change.file,
      ) &&
      change.file !== `${directory}/.zeros-canvas.json` &&
      !change.file.startsWith(`${directory}/`) &&
      ![...migrationDirectories].some(
        (folder) =>
          change.file === `${folder}/${DESIGN_MANIFEST_FILE}` ||
          change.file === `${folder}/${DESIGN_CANVAS_FILE}` ||
          change.file === `${folder}/rules.md`,
      )
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
    if (name === privateDraftFenceName) { privateDraftFenceSchema.parse(JSON.parse(source)); continue; }
    const journal = migrationSchema.parse(JSON.parse(source));
    if (journalName(journal.directory) !== name)
      throw new Error("Invalid Design recovery record identity.");
    recoverDesignMetadataMigration(workspace, journal.directory);
  }
  if (recoverWorkspaceDesignPagesMigrations(workspace).length)
    invalidateDesignManifestDiscovery(workspace);
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
  restoredId?: string,
): string[] {
  assertDesignWriteAuthorized();
  if (sanitizeDesignDirectoryName(directory) !== directory)
    throw new Error("Invalid Design directory.");
  recoverDesignMetadataMigration(workspace, directory);
  const registrySnapshot = readDesignRegistrySource(workspace);
  const registryBefore = registrySnapshot.source;
  if (
    expected &&
    (registryBefore !== expected.registry ||
      (expected.registryFile !== undefined &&
        registrySnapshot.file !== expected.registryFile) ||
      readDesignStorageFile(workspace, expected.file) !== expected.source ||
      (expected.registration !== undefined &&
        readDesignStorageFile(workspace, expected.registration.file) !== expected.registration.source))
  )
    throw new Error(
      "Design metadata changed while this edit was being prepared. Refresh before retrying.",
    );
  if (readDirectoryDesignManifest(workspace, directory))
    rememberManifest(workspace, directory);
  const registry = readDesignDirectoryRegistry(workspace) ?? {
    version: 1 as const,
    directories: {} as DesignDirectoryRegistry["directories"],
  };
  const existing = Object.entries(registry.directories).find(
    ([, entry]) => entry.path === directory,
  );
  const legacy = `${directory}/.zeros-canvas.json`;
  const legacyBefore = readDesignStorageFile(workspace, legacy);
  if (
    restoredId &&
    (!DESIGN_DIRECTORY_ID_PATTERN.test(restoredId) ||
      (existing && existing[0] !== restoredId))
  )
    throw new Error("The restored Design identity conflicts with this folder.");
  const id =
    existing?.[0] ??
    restoredId ??
    (legacyBefore !== null
      ? legacyDesignDirectoryId(directory)
      : `design_${randomUUID().replace(/-/g, "")}`);
  if (!existing && registry.directories[id])
    throw new Error(
      "A legacy Design directory conflicts with an existing identity.",
    );
  registry.directories[id] = { path: directory };
  designDirectoryRegistrySchema.parse(registry);
  const oldRegistry =
    registryBefore === null
      ? null
      : parseDesignDirectoryRegistry(registryBefore);
  const changes: DesignStorageChange[] = [];
  const deletions: DesignStorageChange[] = [];
  const visibleFiles: string[] = [];
  // Migrate every central entry before making .zeros private. Otherwise an
  // unselected, uncommitted document would become hidden by the new ignore rule.
  const migrating = new Map(
    Object.entries(oldRegistry?.directories ?? {}).map(([key, value]) => [
      key,
      value.path,
    ]),
  );
  migrating.set(id, directory);
  for (const [entryId, folder] of migrating) {
    const layout = readDirectoryDesignLayout(workspace, folder);
    const metadata = layout?.manifestFile ?? `${folder}/${DESIGN_MANIFEST_FILE}`;
    const before = readDesignStorageFile(workspace, metadata);
    const manifest = before === null ? null : parseDesignManifest(before);
    if (before !== null && !manifest)
      throw new Error(
        `The existing ${metadata} is not a Zeros Design manifest. Choose another folder or resolve that filename first.`,
      );
    if (manifest && manifest.id !== entryId)
      throw new Error("Design manifest identity changed during migration.");
    const oldFile = designDocumentMetadataRelativePath(workspace, entryId);
    const oldSource = readDesignStorageFile(workspace, oldFile);
    const canvasSource = readDesignStorageFile(
      workspace,
      `${folder}/.zeros-canvas.json`,
    );
    if (
      [before, oldSource, canvasSource].filter((source) => source !== null)
        .length > 1
    )
      throw new Error(
        "Both legacy and registered Design metadata exist. Resolve the conflict before editing.",
      );
    const canvasFile = layout?.manifest.canvas ? layout.documentFile : `${folder}/${DESIGN_CANVAS_FILE}`;
    const canvasBefore = readDesignStorageFile(workspace, canvasFile);
    if (canvasBefore !== null && !manifest?.canvas && expected?.file !== canvasFile)
      throw new Error(`The existing ${canvasFile} conflicts with legacy Design metadata. Preserve both files before migrating.`);
    const json = folder === directory ? document : oldSource;
    if (json === null)
      throw new Error(
        `The registered Design metadata for ${folder} is missing.`,
      );
    let model = JSON.parse(json) as Record<string, unknown>;
    if (!manifest?.canvas) {
      // Old documents discovered every top-level HTML file. Capture that
      // membership and inline metadata before switching to explicit entries,
      // including other folders migrated with a shared central registry.
      const normalized = decodeCanvasFile(encodeCanvasFile(model)) as unknown as CanvasDocument;
      const information = (model.frame_info ?? {}) as Record<string, unknown>;
      const names = new Set([
        ...Object.keys(normalized.frames),
        ...(existsSync(path.join(workspace, folder)) ? readdirSync(path.join(workspace, folder), { withFileTypes: true }) : [])
          .filter((entry) => entry.isFile() && isDesignFrameFile(entry.name))
          .map((entry) => entry.name),
      ]);
      for (const file of [...names].sort()) {
        const pending = sourceChanges.find((change) => change.file === `${folder}/${file}`);
        if (pending?.after === null) continue;
        if (Object.hasOwn(information, file) && normalized.frames[file]) continue;
        const source = pending?.after ?? readDesignStorageFile(workspace, `${folder}/${file}`, 2 * 1024 * 1024);
        if (source === null) {
          if (normalized.frames[file]) continue; // Preserve an existing missing reference for recovery.
          throw new Error(`Design frame source is missing: ${folder}/${file}`);
        }
        const meta = readFrameMeta(parseHtml(source, { sourceCodeLocationInfo: true }), file);
        normalized.frames[file] ??= nextFrameGeometry(Object.values(normalized.frames), meta);
        normalized.frame_info[file] = { ...normalized.frame_info[file], title: meta.title, kind: meta.kind };
      }
      model = { ...normalized };
    }
    const canvasAfter = encodeCanvasFile(model, { version: layout?.canvasVersion ?? 1 });
    // Preserve formatting when the authored scene itself is unchanged.
    const unchanged = canvasBefore !== null &&
      isDeepStrictEqual(JSON.parse(canvasBefore), JSON.parse(canvasAfter));
    changes.push({ file: canvasFile, before: canvasBefore, after: unchanged ? canvasBefore : canvasAfter });
    changes.push({ file: metadata, before, after: manifest?.canvas ? before : serializeDesignRegistration(entryId) });
    const rules = `${folder}/rules.md`;
    const rulesBefore = readDesignStorageFile(workspace, rules);
    const rulesAfter = upgradedDesignRules(rulesBefore, layout?.canvasVersion ?? 1);
    if (rulesBefore !== rulesAfter)
      changes.push({ file: rules, before: rulesBefore, after: rulesAfter });
    visibleFiles.push(metadata, canvasFile, rules);
    if (oldSource !== null)
      deletions.push({ file: oldFile, before: oldSource, after: null });
  }
  changes.push(...sourceChanges);
  if (legacyBefore !== null)
    deletions.push({ file: legacy, before: legacyBefore, after: null });
  if (registryBefore !== null)
    deletions.push({
      file: registrySnapshot.file,
      before: registryBefore,
      after: null,
    });
  const oldRules = readDesignStorageFile(workspace, DESIGN_RULES_FILE);
  // Preserve user additions in old rules; it is not document metadata.
  if (
    oldRules !== null &&
    oldRules ===
      "# Zeros Design metadata\nThis folder stores the shared Design directory registry and document metadata.\nKeep this folder and its contents in Git; it must not be gitignored.\nZeros manages these files through Zeros Settings and Design mode, using the Design API.\nCode agents may read this folder but must not create, edit, move, delete, stage, or commit anything inside it through generic tools.\nKeep personal settings, sessions, caches, and recovery records outside this folder.\n"
  )
    deletions.push({ file: DESIGN_RULES_FILE, before: oldRules, after: null });
  changes.push(...deletions);
  const effectiveChanges = changes.filter(
    (change) => change.before !== change.after,
  );
  changes.splice(0, changes.length, ...effectiveChanges);
  const ignoreBefore = readDesignStorageFile(workspace, ".gitignore");
  const ignoreAfter = designGitignoreSource(
    ignoreBefore,
    Object.values(registry.directories).map((entry) => entry.path),
  );
  if (Buffer.byteLength(ignoreAfter) > MAX_METADATA_BYTES)
    throw new Error(
      "The repository Git ignore file exceeds the Design storage limit.",
    );
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
  // Repository configuration is repaired before starting a document write.
  // A higher-priority nested exclusion must not produce a successful save
  // whose metadata is hidden. The ignore edit stays reviewable on failure.
  const ignoreChanges: string[] = [];
  if (ignoreAfter !== ignoreBefore) {
    if (readDesignStorageFile(workspace, ".gitignore") !== ignoreBefore)
      throw new Error(
        "Git ignore rules changed while preparing Design metadata.",
      );
    atomicWrite(workspace, ".gitignore", ignoreAfter);
    ignoreChanges.push(".gitignore");
  }
  assertDesignFilesNotIgnored(workspace, visibleFiles);
  if (!changes.length) return ignoreChanges;
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
  for (const folder of migrating.values()) rememberManifest(workspace, folder);
  return [...ignoreChanges, ...changes.map((change) => change.file)];
}

/** Explicit Settings removal: enumerate metadata exactly, never the source tree. */
export function prepareDesignMetadataRemoval(
  workspace: string,
  directory: string,
) {
  if (sanitizeDesignDirectoryName(directory) !== directory)
    throw new Error("Invalid Design directory.");
  recoverWorkspaceDesignMetadata(workspace);
  const layout = readDirectoryDesignLayout(workspace, directory);
  const manifestSource = readDesignStorageFile(
    workspace,
    `${directory}/${DESIGN_MANIFEST_FILE}`,
  );
  if (manifestSource !== null && !parseDesignManifest(manifestSource))
    throw new Error(
      "The existing design.toml is not a Zeros Design manifest. Resolve that filename before removing the registration.",
    );
  const entry = designDirectoryEntry(workspace, directory);
  const legacy = `${directory}/.zeros-canvas.json`;
  if (!entry && readDesignStorageFile(workspace, legacy) === null)
    throw new Error("This folder has no Design registration to remove.");
  const changes: DesignStorageChange[] = [];
  const remove = (file: string) => {
    const before = readDesignStorageFile(workspace, file);
    if (before !== null) changes.push({ file, before, after: null });
  };
  remove(layout?.manifestFile ?? `${directory}/${DESIGN_MANIFEST_FILE}`);
  // Both public canvas layouts are authored source. Unregistering retains the
  // scene/catalog for explicit re-adoption, just as root canvas.json is kept.
  remove(legacy);
  const rules = `${directory}/rules.md`;
  if (GENERATED_DESIGN_RULES.includes(readDesignStorageFile(workspace, rules) ?? "")) remove(rules);
  if (entry) {
    remove(designDocumentRelativePath(entry.id));
    remove(`${designDocumentMetadataDirectory(entry.id)}/document.json`);
    const registry = readDesignRegistrySource(workspace);
    if (registry.source !== null) {
      const model = parseDesignDirectoryRegistry(registry.source);
      if (model.directories[entry.id]?.path === directory) {
        delete model.directories[entry.id];
        changes.push({
          file: registry.file,
          before: registry.source,
          after: Object.keys(model.directories).length
            ? stringify(model)
            : null,
        });
      }
    }
  }
  return {
    id: entry?.id,
    changes,
    rollback() {
      applyStorageChanges(
        workspace,
        directory,
        changes.map((change) => ({
          file: change.file,
          before: change.after,
          after: change.before,
        })),
      );
      invalidateDesignManifestDiscovery(workspace);
    },
    apply() {
      const journal = writePrivateDesignState(
        workspace,
        journalName(directory),
        JSON.stringify({
          version: 1,
          workspace: path.resolve(workspace),
          directory,
          changes,
        }),
      );
      applyStorageChanges(workspace, directory, changes);
      unlinkSync(journal);
      syncDirectory(path.dirname(journal));
      invalidateDesignManifestDiscovery(workspace);
    },
  };
}

const directoryRenameSchema = z
  .object({
    version: z.literal(1),
    from: z.string(),
    to: z.string(),
    before: z.string(),
    after: z.string(),
    file: z.enum(DESIGN_DIRECTORY_REGISTRY_FILES).optional(),
  })
  .strict();
/** Record the registry half before the Design API moves a source directory.
 * Metadata filenames use the ID, so a directory rename never moves metadata.json. */
export function prepareDesignDirectoryRename(
  workspace: string,
  from: string,
  to: string,
): string {
  if (!sanitizeDesignDirectoryName(from) || !sanitizeDesignDirectoryName(to))
    throw new Error("Invalid Design directory rename.");
  assertSafeDesignStoragePath(workspace, `${from}/.zeros-validation`);
  assertSafeDesignStoragePath(workspace, `${to}/.zeros-validation`);
  const manifest = readDirectoryDesignManifest(workspace, from);
  if (manifest) {
    const registry = readDesignDirectoryRegistry(workspace)!;
    registry.directories[manifest.id].path = to;
    designDirectoryRegistrySchema.parse(registry);
    invalidateDesignManifestDiscovery(workspace);
    return manifest.id;
  }
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
      file: DESIGN_DIRECTORY_REGISTRY_FILE,
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
  // Recovery records written before the layout migration used the old path.
  const registryFile = record.file ?? LEGACY_DESIGN_DIRECTORY_REGISTRY_FILE;
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
    if (readDesignStorageFile(workspace, registryFile) !== record.before)
      throw new Error("The registry changed during Design rename recovery.");
  } else if (!fromExists && toExists) {
    assertSafeDesignStoragePath(workspace, `${record.to}/.zeros-validation`);
    applyStorageChanges(workspace, record.to, [
      {
        file: registryFile,
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
