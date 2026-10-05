import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  mayReferenceMovedDesignFrame,
  rebaseDesignCssReferences,
  rebaseDesignHtmlReferences,
} from "@zeros/design-web";
import { isDesignPageFolder } from "@zeros/protocol/design-path";
import {
  decodeCanvasFile,
  encodeCanvasFile,
  legacyFrameId,
} from "./canvas-file";
import { parseDesignManifest, serializeDesignRegistration } from "./manifest";
import {
  DESIGN_DIRECTORY_ID_PATTERN,
  sanitizeDesignDirectoryName,
} from "./directory-path";
import { upgradedDesignRules } from "./design-rules";
import {
  assertDesignFilesNotIgnored,
  designGitignoreSource,
} from "./gitignore";
import { TOKENS_SEED } from "./document-seeds";
import { assertDesignWriteAuthorized } from "./write-authority";
import { publishCloudWorkspacePath } from "../files/cloud-workspace-ownership";
import {
  assertSafeDesignStoragePath as assertStoragePath,
  atomicWriteDesignStorageFile,
  designPrivateStorageDirectory,
  readDesignStorageFile,
  syncDesignStorageDirectory,
  writePrivateDesignState,
} from "./metadata-storage";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const portable = (value: string) => value.normalize("NFC").toLowerCase();
const digest = (value: string | null) =>
  value === null ? null : createHash("sha256").update(value).digest("hex");
const directoryKey = (directory: string) =>
  createHash("sha256").update(directory).digest("hex").slice(0, 24);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const payload = z
  .string()
  .regex(/^[0-9]+-(?:before|after)\.txt$/)
  .nullable();
const journalSchema = z
  .object({
    version: z.literal(1),
    workspace: z.string(),
    directory: z.string(),
    id: z.string().regex(DESIGN_DIRECTORY_ID_PATTERN),
    token: z.string().regex(/^[a-f0-9]{32}$/),
    phase: z.enum([
      "prepared",
      "sources",
      "metadata",
      "deleted",
      "invalidated",
      "complete",
    ]),
    folders: z.array(z.string().refine(isDesignPageFolder)).min(1).max(64),
    changes: z
      .array(
        z
          .object({
            file: z.string().min(1).max(4096),
            group: z.enum(["source", "metadata", "delete"]),
            before: hash.nullable(),
            after: hash.nullable(),
            beforePayload: payload,
            afterPayload: payload,
            mode: z.number().int().min(0).max(0o777),
          })
          .strict(),
      )
      .max(20_520),
    guards: z.array(z.object({ file: z.string(), hash }).strict()).max(20_000),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
type Change = Journal["changes"][number];
type SourceChange = {
  file: string;
  group: Change["group"];
  before: string | null;
  after: string | null;
  mode?: number;
};

export interface DesignPagesMigrationOptions {
  directories?: string[];
  /** Deterministic crash seam. Runtime callers never pass a callback. */
  afterStep?: (step: string) => void;
}
export const designPagesMigrationJournalName = (directory: string) =>
  "pages-" + directoryKey(directory) + ".json";
const payloadDirectory = (journal: Pick<Journal, "directory" | "token">) =>
  "pages-" + directoryKey(journal.directory) + "-" + journal.token;
const generationName = (directory: string) =>
  "page-generation-" + directoryKey(directory) + ".json";
function migrationPathError(file: string, error: unknown): never {
  throw new Error(
    "Cannot safely access Design migration path " +
      file +
      ": " +
      (error instanceof Error ? error.message : String(error)),
  );
}
function assertSafeDesignStoragePath(root: string, file: string): string {
  try {
    return assertStoragePath(root, file);
  } catch (error) {
    return migrationPathError(file, error);
  }
}
function read(
  root: string,
  file: string,
  limit = MAX_METADATA_BYTES,
): string | null {
  try {
    return readDesignStorageFile(root, file, limit, true);
  } catch (error) {
    return migrationPathError(file, error);
  }
}

export function designPagesMigrationGeneration(
  workspace: string,
  directory: string,
): string | null {
  const source = read(
    designPrivateStorageDirectory(workspace),
    generationName(directory),
    4096,
  );
  if (source === null) return null;
  const value = z
    .object({
      version: z.literal(1),
      directory: z.literal(directory),
      token: z.string().regex(/^[a-f0-9]{32}$/),
    })
    .strict()
    .parse(JSON.parse(source));
  return value.token;
}

export function readDesignPagesMigrationJournal(
  workspace: string,
  directory: string,
): Journal | null {
  const source = read(
    designPrivateStorageDirectory(workspace),
    designPagesMigrationJournalName(directory),
    MAX_JOURNAL_BYTES,
  );
  if (source === null) return null;
  const journal = journalSchema.parse(JSON.parse(source));
  if (
    journal.workspace !== path.resolve(workspace) ||
    journal.directory !== directory ||
    sanitizeDesignDirectoryName(directory) !== directory
  )
    throw new Error(
      "Design page migration belongs to another directory. Preserve its recovery record.",
    );
  if (
    new Set(journal.changes.map((change) => change.file)).size !==
      journal.changes.length ||
    new Set(journal.folders.map(portable)).size !== journal.folders.length
  )
    throw new Error("Design page migration has duplicate paths or folders.");
  for (const [index, change] of journal.changes.entries()) {
    if (
      (change.file !== ".gitignore" &&
        !change.file.startsWith(directory + "/")) ||
      (change.file === ".gitignore" &&
        (change.group !== "source" || change.after === null)) ||
      path.posix.normalize(change.file) !== change.file ||
      change.file.includes("\\") ||
      (change.before === null) !== (change.beforePayload === null) ||
      (change.after === null) !== (change.afterPayload === null) ||
      (change.beforePayload !== null &&
        change.beforePayload !== index + "-before.txt") ||
      (change.afterPayload !== null &&
        change.afterPayload !== index + "-after.txt") ||
      (change.group === "delete"
        ? change.after !== null
        : change.after === null)
    )
      throw new Error(
        "Invalid Design page migration path or payload identity.",
      );
    assertSafeDesignStoragePath(workspace, change.file);
  }
  for (const guard of journal.guards)
    if (
      !guard.file.startsWith(directory + "/") ||
      path.posix.normalize(guard.file) !== guard.file
    )
      throw new Error("Invalid Design page migration input path.");
  return journal;
}

/** Recognize only our captured old/new registrations during an admitted move.
 * Discovery stays observational; authoring/lifecycle recovery finishes the plan. */
export function designPagesMigrationOwnsManifests(
  workspace: string,
  directory: string,
  rootSource: string,
  metaSource: string,
): boolean {
  const journal = readDesignPagesMigrationJournal(workspace, directory);
  if (!journal) return false;
  const old = journal.changes.find(
    (change) => change.file === directory + "/design.toml",
  );
  const next = journal.changes.find(
    (change) => change.file === directory + "/meta/design.toml",
  );
  const canvas = journal.changes.find(
    (change) => change.file === directory + "/meta/canvas.json",
  );
  if (
    old?.before !== digest(rootSource) ||
    next?.after !== digest(metaSource) ||
    !canvas ||
    digest(read(workspace, canvas.file)) !== canvas.after
  )
    return false;
  return journal.changes
    .filter((change) => change.group === "source")
    .every((change) => digest(read(workspace, change.file)) === change.after);
}

function sourceFiles(workspace: string, directory: string): string[] {
  const result: string[] = [],
    pending = [directory];
  let visited = 0;
  while (pending.length) {
    const folder = pending.pop()!;
    if (++visited > 20_000)
      throw new Error(
        "Design page migration exceeds the source discovery limit.",
      );
    assertSafeDesignStoragePath(workspace, folder + "/.zeros-validation");
    const entries = readdirSync(path.join(workspace, folder), {
      withFileTypes: true,
    });
    visited += entries.length;
    if (visited > 20_000)
      throw new Error(
        "Design page migration exceeds the source discovery limit.",
      );
    for (const entry of entries) {
      const file = folder + "/" + entry.name;
      if (entry.name === ".git")
        throw new Error(
          "Cannot migrate a Design directory containing a nested repository: " +
            file,
        );
      if (["node_modules", ".zeros", ".context"].includes(entry.name)) continue;
      if (entry.isSymbolicLink())
        throw new Error("Cannot safely migrate a linked Design path: " + file);
      if (entry.isDirectory()) pending.push(file);
      else if (/\.(?:html|css)$/i.test(entry.name)) {
        assertSafeDesignStoragePath(workspace, file);
        result.push(file);
      }
    }
  }
  return result.sort();
}

function assertInputs(workspace: string, journal: Journal): void {
  for (const change of journal.changes) {
    const current = digest(read(workspace, change.file));
    if (current !== change.before && current !== change.after)
      throw new Error(
        "Design source changed during page migration: " +
          change.file +
          ". Preserve the recovery record and resolve the changed bytes before retrying.",
      );
  }
  for (const guard of journal.guards)
    if (digest(read(workspace, guard.file, MAX_SOURCE_BYTES)) !== guard.hash)
      throw new Error(
        "Design migration input changed: " +
          guard.file +
          ". Recovery is paused.",
      );
  const changed = new Set(journal.changes.map((change) => change.file));
  const current = sourceFiles(workspace, journal.directory).filter(
    (file) => !changed.has(file),
  );
  if (
    JSON.stringify(current) !==
    JSON.stringify(journal.guards.map((guard) => guard.file).sort())
  )
    throw new Error(
      "Design reference files changed during page migration. Recovery is paused before removing predecessors.",
    );
  const ignore = journal.changes.find((change) => change.file === ".gitignore");
  const plannedIgnore = ignore
    ? payloadSource(workspace, journal, ignore.afterPayload, ignore.after)
    : undefined;
  assertDesignFilesNotIgnored(
    workspace,
    journal.changes
      .filter((change) => change.after !== null)
      .map((change) => change.file),
    plannedIgnore,
  );
}

function assertSuccessors(workspace: string, journal: Journal): void {
  for (const change of journal.changes.filter(
    (change) => change.group !== "delete",
  ))
    if (digest(read(workspace, change.file)) !== change.after)
      throw new Error(
        "Design migration successor is changed or missing: " +
          change.file +
          ". Recovery is paused before removing predecessors.",
      );
}

function cleanPayloads(
  workspace: string,
  name: string,
  afterStep?: (step: string) => void,
): void {
  const root = designPrivateStorageDirectory(workspace);
  if (!existsSync(path.join(root, name))) return;
  assertSafeDesignStoragePath(root, name + "/.zeros-validation");
  for (const entry of readdirSync(path.join(root, name)).sort()) {
    if (
      !/^[0-9]+-(?:before|after)\.txt(?:\.[a-f0-9-]+\.zeros-tmp)?$/.test(entry)
    )
      throw new Error(
        "Unexpected private Design migration payload; preserve it for recovery.",
      );
    const target = assertSafeDesignStoragePath(root, name + "/" + entry);
    unlinkSync(target);
    syncDesignStorageDirectory(path.join(root, name));
    afterStep?.("cleanup:" + entry);
  }
  rmdirSync(path.join(root, name));
  syncDesignStorageDirectory(root);
  afterStep?.("cleanup:directory");
}

function payloadSource(
  workspace: string,
  journal: Journal,
  name: string | null,
  expected: string | null,
): string {
  if (!name || !expected)
    throw new Error("Design migration payload is missing.");
  const source = read(
    designPrivateStorageDirectory(workspace),
    payloadDirectory(journal) + "/" + name,
  );
  if (source === null || digest(source) !== expected)
    throw new Error(
      "Design migration payload is missing or changed. Preserve the private recovery record.",
    );
  return source;
}

function persistPhase(
  workspace: string,
  journal: Journal,
  phase: Journal["phase"],
  afterStep?: (step: string) => void,
): void {
  journal.phase = phase;
  writePrivateDesignState(
    workspace,
    designPagesMigrationJournalName(journal.directory),
    JSON.stringify(journal),
    {
      temporaryToken: journal.token,
      afterPrepare: () => afterStep?.("atomic-phase:" + phase),
    },
  );
  afterStep?.("phase:" + phase);
}

function applyJournal(
  workspace: string,
  journal: Journal,
  afterStep?: (step: string) => void,
): string[] {
  const root = designPrivateStorageDirectory(workspace);
  // The journal is durable before any authored temporary is created. Only
  // names derived from its immutable token and targets are ours to remove.
  for (const [storage, file] of [
    ...journal.changes.map((change) => [workspace, change.file] as const),
    [root, designPagesMigrationJournalName(journal.directory)] as const,
    [root, generationName(journal.directory)] as const,
  ]) {
    const temporary = assertSafeDesignStoragePath(
      storage,
      file + "." + journal.token + ".zeros-tmp",
    );
    if (existsSync(temporary)) {
      unlinkSync(temporary);
      syncDesignStorageDirectory(path.dirname(temporary));
      afterStep?.("temporary-removed:" + file);
    }
  }
  if (journal.phase !== "complete") {
    assertInputs(workspace, journal);
    for (const change of journal.changes) {
      if (change.before !== null)
        payloadSource(workspace, journal, change.beforePayload, change.before);
      if (change.after !== null)
        payloadSource(workspace, journal, change.afterPayload, change.after);
    }
    for (const folder of ["meta", ...journal.folders]) {
      const relative = journal.directory + "/" + folder;
      const target = path.join(workspace, relative);
      assertSafeDesignStoragePath(workspace, relative + "/.zeros-validation");
      if (!existsSync(target)) {
        mkdirSync(target);
        publishCloudWorkspacePath(target);
        syncDesignStorageDirectory(path.dirname(target));
        afterStep?.("directory:" + folder);
      }
    }
    for (const group of ["source", "metadata"] as const) {
      for (const change of journal.changes.filter(
        (change) => change.group === group,
      )) {
        const current = digest(read(workspace, change.file));
        if (current === change.after) continue;
        if (current !== change.before)
          throw new Error(
            "Design source changed before migration write: " + change.file,
          );
        const source = payloadSource(
          workspace,
          journal,
          change.afterPayload,
          change.after,
        );
        atomicWriteDesignStorageFile(
          workspace,
          change.file,
          source,
          change.mode,
          {
            temporaryToken: journal.token,
            afterPrepare: () =>
              afterStep?.(
                "atomic-" +
                  group +
                  ":" +
                  (change.file.startsWith(journal.directory + "/")
                    ? change.file.slice(journal.directory.length + 1)
                    : change.file),
              ),
            beforePublish: () => {
              if (digest(read(workspace, change.file)) !== change.before)
                throw new Error(
                  "Design source changed before migration publish: " +
                    change.file,
                );
            },
          },
        );
        if (digest(read(workspace, change.file)) !== change.after)
          throw new Error(
            "Design migration write verification failed: " + change.file,
          );
        afterStep?.(
          group +
            ":" +
            (change.file.startsWith(journal.directory + "/")
              ? change.file.slice(journal.directory.length + 1)
              : change.file),
        );
      }
      if (["prepared", "sources"].includes(journal.phase))
        persistPhase(
          workspace,
          journal,
          group === "source" ? "sources" : "metadata",
          afterStep,
        );
    }
    // Verify all successors, including surgical inbound edits, before deleting
    // any old frame or registration. Recheck after every predecessor deletion.
    assertInputs(workspace, journal);
    assertSuccessors(workspace, journal);
    for (const change of journal.changes.filter(
      (change) => change.group === "delete",
    )) {
      if (digest(read(workspace, change.file)) === null) continue;
      assertInputs(workspace, journal);
      assertSuccessors(workspace, journal);
      payloadSource(workspace, journal, change.beforePayload, change.before);
      const target = assertSafeDesignStoragePath(workspace, change.file);
      unlinkSync(target);
      syncDesignStorageDirectory(path.dirname(target));
      afterStep?.("delete:" + change.file.slice(journal.directory.length + 1));
    }
    assertInputs(workspace, journal);
    assertSuccessors(workspace, journal);
    if (!["deleted", "invalidated"].includes(journal.phase))
      persistPhase(workspace, journal, "deleted", afterStep);
    const generation = JSON.stringify({
      version: 1,
      directory: journal.directory,
      token: journal.token,
    });
    if (read(root, generationName(journal.directory), 4096) !== generation) {
      writePrivateDesignState(
        workspace,
        generationName(journal.directory),
        generation,
        {
          temporaryToken: journal.token,
          afterPrepare: () => afterStep?.("atomic-cache-generation"),
        },
      );
      afterStep?.("cache-generation");
    }
    if (journal.phase !== "invalidated")
      persistPhase(workspace, journal, "invalidated", afterStep);
    assertInputs(workspace, journal);
    assertSuccessors(workspace, journal);
    for (const change of journal.changes.filter(
      (change) => change.group === "delete",
    ))
      if (read(workspace, change.file) !== null)
        throw new Error(
          "Design predecessor reappeared during migration: " +
            change.file +
            ". Preserve the recovery record.",
        );
    persistPhase(workspace, journal, "complete", afterStep);
  }
  cleanPayloads(workspace, payloadDirectory(journal), afterStep);
  const target = assertSafeDesignStoragePath(
    root,
    designPagesMigrationJournalName(journal.directory),
  );
  unlinkSync(target);
  syncDesignStorageDirectory(root);
  afterStep?.("journal-removed");
  return journal.changes.map((change) => change.file);
}

export function recoverDesignPagesMigration(
  workspace: string,
  directory: string,
): string[] {
  const journal = readDesignPagesMigrationJournal(workspace, directory);
  return journal ? applyJournal(workspace, journal) : [];
}

export function recoverWorkspaceDesignPagesMigrations(
  workspace: string,
): string[] {
  const root = designPrivateStorageDirectory(workspace);
  if (!existsSync(root)) return [];
  const recovered: string[] = [];
  for (const name of readdirSync(root).filter((name) =>
    /^pages-[a-f0-9]{24}\.json$/.test(name),
  )) {
    const source = read(root, name, MAX_JOURNAL_BYTES);
    if (source === null) continue;
    const directory = journalSchema.parse(JSON.parse(source)).directory;
    if (designPagesMigrationJournalName(directory) !== name)
      throw new Error("Invalid Design page migration journal identity.");
    recovered.push(...recoverDesignPagesMigration(workspace, directory));
  }
  return recovered;
}

function admitPlan(
  workspace: string,
  directory: string,
  id: string,
  folders: string[],
  changes: SourceChange[],
  guards: Journal["guards"],
  options: DesignPagesMigrationOptions,
): string[] {
  assertDesignWriteAuthorized();
  const key = directoryKey(directory),
    privateRoot = designPrivateStorageDirectory(workspace);
  for (const candidate of [
    "metadata-" + key + ".json",
    "transaction-" + key + ".json",
    "transaction-" + id + ".json",
  ])
    if (read(privateRoot, candidate) !== null)
      throw new Error(
        "Finish the pending Design recovery journal before migrating pages: " +
          candidate,
      );
  if (read(workspace, directory + "/.zeros-transaction.json") !== null)
    throw new Error(
      "Finish the pending legacy Design transaction before migrating pages.",
    );
  for (const change of changes) {
    if (read(workspace, change.file) !== change.before)
      throw new Error(
        "Design source changed during migration preflight: " + change.file,
      );
    assertSafeDesignStoragePath(workspace, change.file);
  }
  const ignoreBefore = read(workspace, ".gitignore");
  const ignoreAfter = designGitignoreSource(
    ignoreBefore,
    options.directories ?? [directory],
  );
  if (ignoreBefore !== ignoreAfter)
    changes.unshift({
      file: ".gitignore",
      group: "source",
      before: ignoreBefore,
      after: ignoreAfter,
    });
  assertDesignFilesNotIgnored(
    workspace,
    changes
      .filter((change) => change.after !== null)
      .map((change) => change.file),
    ignoreAfter,
  );
  // Abandoned preparation has never modified authored source. Only our own
  // validated, unadmitted private payload directories are removable.
  if (existsSync(privateRoot))
    for (const name of readdirSync(privateRoot)) {
      if (new RegExp("^pages-" + key + "-[a-f0-9]{32}$").test(name))
        cleanPayloads(workspace, name);
      else if (
        new RegExp(
          "^pages-" + key + "\\.json\\.[a-f0-9]{32}\\.zeros-tmp$",
        ).test(name)
      ) {
        unlinkSync(assertSafeDesignStoragePath(privateRoot, name));
        syncDesignStorageDirectory(privateRoot);
      }
    }
  const token = randomUUID().replace(/-/g, "");
  const journal: Journal = {
    version: 1,
    workspace: path.resolve(workspace),
    directory,
    id,
    token,
    phase: "prepared",
    folders,
    changes: [],
    guards,
  };
  const payloadRoot = payloadDirectory(journal);
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(privateRoot, payloadRoot), { mode: 0o700 });
  syncDesignStorageDirectory(privateRoot);
  let admitted = false;
  try {
    options.afterStep?.("payload-directory");
    for (const [index, change] of changes.entries()) {
      const beforePayload =
        change.before === null ? null : index + "-before.txt";
      const afterPayload = change.after === null ? null : index + "-after.txt";
      for (const [name, source] of [
        [beforePayload, change.before],
        [afterPayload, change.after],
      ] as const) {
        if (name !== null && source !== null) {
          atomicWriteDesignStorageFile(
            privateRoot,
            payloadRoot + "/" + name,
            source,
          );
          options.afterStep?.("payload:" + name);
        }
      }
      journal.changes.push({
        file: change.file,
        group: change.group,
        before: digest(change.before),
        after: digest(change.after),
        beforePayload,
        afterPayload,
        mode: change.mode ?? 0o600,
      });
    }
    if (Buffer.byteLength(JSON.stringify(journal)) > MAX_JOURNAL_BYTES)
      throw new Error(
        "Design page migration has too many reference paths for a recovery journal.",
      );
    assertInputs(workspace, journal);
    assertDesignWriteAuthorized();
    writePrivateDesignState(
      workspace,
      designPagesMigrationJournalName(directory),
      JSON.stringify(journal),
      {
        temporaryToken: journal.token,
        afterPrepare: () => options.afterStep?.("atomic-phase:prepared"),
      },
    );
    admitted = true;
    options.afterStep?.("phase:prepared");
    return applyJournal(workspace, journal, options.afterStep);
  } catch (error) {
    if (!admitted) cleanPayloads(workspace, payloadRoot);
    throw error;
  }
}

function buildPlan(
  workspace: string,
  directory: string,
  id: string,
  document: Record<string, unknown>,
  legacy: { manifest: string; canvas: string } | null,
  options: DesignPagesMigrationOptions,
  preservedCanvas?: string,
): string[] {
  assertSafeDesignStoragePath(workspace, directory + "/meta/.zeros-validation");
  const metaManifest = read(workspace, directory + "/meta/design.toml");
  const metaCanvas = read(workspace, directory + "/meta/canvas.json");
  if (
    metaManifest !== null ||
    (metaCanvas !== null && preservedCanvas === undefined)
  )
    throw new Error(
      "Existing meta/design.toml or meta/canvas.json conflicts with the page migration. Preserve both versions before retrying.",
    );
  const occupied = new Set(
    readdirSync(path.join(workspace, directory)).map(portable),
  );
  let folder = "page-1";
  for (let suffix = 2; occupied.has(portable(folder)); suffix++)
    folder = "page-1-" + suffix;
  const pages = document.pages as Array<{
    id: string;
    title: string;
    folder?: string;
    frames: string[];
  }>;
  const alreadyPaged =
    pages?.length > 0 && pages.every((page) => page.folder !== undefined);
  const frames = document.frames as Record<string, unknown>;
  const rawInformation = (document.frame_info ?? {}) as Record<
    string,
    { id?: string; [key: string]: unknown }
  >;
  const information = Object.fromEntries(
    Object.keys(frames).map((file) => [
      file,
      {
        ...rawInformation[file],
        id: rawInformation[file]?.id ?? legacyFrameId(file),
      },
    ]),
  );
  const movedFiles = Object.fromEntries(
    (alreadyPaged ? [] : Object.keys(frames)).map((file) => [
      file,
      folder + "/" + file,
    ]),
  );
  const next: Record<string, unknown> = {
    ...document,
    version: 3,
    pages: alreadyPaged
      ? pages
      : [
          {
            ...(pages?.[0] ?? {
              id: "page_" + randomUUID().replace(/-/g, ""),
              title: "Page 1",
              frames: Object.values(information ?? {}).map((info) => info.id),
            }),
            folder,
          },
        ],
    frames: Object.fromEntries(
      Object.entries(frames).map(([file, geometry]) => [
        movedFiles[file] ?? file,
        geometry,
      ]),
    ),
    frame_info: Object.fromEntries(
      Object.entries(information ?? {}).map(([file, info]) => [
        movedFiles[file] ?? file,
        info,
      ]),
    ),
  };
  const canvas = preservedCanvas ?? encodeCanvasFile(next, { version: 2 });
  decodeCanvasFile(canvas, { version: 2 });
  const allSources = sourceFiles(workspace, directory);
  const changes: SourceChange[] = [];
  const sourceSet = new Set(
    allSources.map((file) => file.slice(directory.length + 1)),
  );
  for (const file of Object.keys(frames))
    if (!sourceSet.has(file))
      throw new Error(
        "Design frame source is missing: " + directory + "/" + file,
      );
  for (const full of allSources) {
    const file = full.slice(directory.length + 1),
      source = read(workspace, full, MAX_SOURCE_BYTES)!;
    const target = movedFiles[file] ?? file;
    const origin =
      file.startsWith("components/") && /\.html$/i.test(file) ? "" : file;
    let after = source;
    if (movedFiles[file] || mayReferenceMovedDesignFrame(source, movedFiles)) {
      try {
        after = /\.html$/i.test(file)
          ? rebaseDesignHtmlReferences(
              source,
              origin,
              movedFiles[file] ?? origin,
              { movedFiles, strict: true },
            )
          : rebaseDesignCssReferences(source, file, file, {
              movedFiles,
              strict: true,
            });
      } catch (error) {
        throw new Error(
          "Cannot safely rebase " +
            full +
            ": " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    const mode = lstatSync(path.join(workspace, full)).mode & 0o777;
    if (target !== file) {
      if (read(workspace, directory + "/" + target) !== null)
        throw new Error("Design page destination already exists: " + target);
      changes.push({
        file: directory + "/" + target,
        group: "source",
        before: null,
        after,
        mode,
      });
      changes.push({
        file: full,
        group: "delete",
        before: source,
        after: null,
        mode,
      });
    } else if (source !== after)
      changes.push({
        file: full,
        group: "source",
        before: source,
        after,
        mode,
      });
  }
  changes.push({
    file: directory + "/meta/canvas.json",
    group: "metadata",
    before: metaCanvas,
    after: canvas,
  });
  const rulesFile = directory + "/rules.md",
    rulesBefore = read(workspace, rulesFile);
  const rulesAfter = upgradedDesignRules(rulesBefore, 2);
  if (rulesBefore !== rulesAfter)
    changes.push({
      file: rulesFile,
      group: "metadata",
      before: rulesBefore,
      after: rulesAfter,
    });
  if (read(workspace, directory + "/tokens.css") === null)
    changes.push({
      file: directory + "/tokens.css",
      group: "metadata",
      before: null,
      after: TOKENS_SEED,
    });
  changes.push({
    file: directory + "/meta/design.toml",
    group: "metadata",
    before: null,
    after: serializeDesignRegistration(id, 3),
  });
  if (legacy)
    changes.push(
      {
        file: directory + "/canvas.json",
        group: "delete",
        before: legacy.canvas,
        after: null,
      },
      {
        file: directory + "/design.toml",
        group: "delete",
        before: legacy.manifest,
        after: null,
      },
    );
  const changed = new Set(changes.map((change) => change.file));
  const guards = allSources
    .filter((file) => !changed.has(file))
    .map((file) => ({
      file,
      hash: digest(read(workspace, file, MAX_SOURCE_BYTES))!,
    }));
  return admitPlan(
    workspace,
    directory,
    id,
    (next.pages as Array<{ folder: string }>).map((page) => page.folder),
    changes,
    guards,
    options,
  );
}

/** Only a v2 root registration enters this migrator. Older envelopes use the
 * existing legacy upgrade first; other directories are never upgraded here. */
export function migrateDesignDirectoryPages(
  workspace: string,
  directory: string,
  options: DesignPagesMigrationOptions = {},
): string[] {
  assertDesignWriteAuthorized();
  const recovered = recoverDesignPagesMigration(workspace, directory);
  const root = read(workspace, directory + "/design.toml");
  const meta = read(workspace, directory + "/meta/design.toml");
  if (meta !== null) {
    if (root !== null)
      throw new Error(
        "Competing root and meta Design manifests exist outside a migration journal.",
      );
    if (parseDesignManifest(meta)?.version !== 3)
      throw new Error(
        "The meta/design.toml registration is not a supported v3 Design manifest.",
      );
    return recovered;
  }
  const manifest = root === null ? null : parseDesignManifest(root);
  if (manifest?.version !== 2 || !manifest.canvas)
    throw new Error(
      "Upgrade legacy Design metadata to the v2 root layout before migrating pages.",
    );
  const canvas = read(workspace, directory + "/" + manifest.canvas);
  if (canvas === null)
    throw new Error("The registered Design canvas metadata is missing.");
  const document = decodeCanvasFile(canvas, { version: 1 });
  if (!Object.hasOwn(JSON.parse(canvas), "pages"))
    (document.pages as Array<{ title: string }>)[0]!.title = "Page 1";
  return [
    ...recovered,
    ...buildPlan(
      workspace,
      directory,
      manifest.id,
      document,
      { manifest: root!, canvas },
      options,
    ),
  ];
}

/** Journal admission for fresh v3 layouts. The metadata lifecycle validates
 * the complete registration catalog before calling this storage seam. */
export function createDesignPagesLayout(
  workspace: string,
  directory: string,
  document: Record<string, unknown>,
  options: DesignPagesMigrationOptions & {
    id: string;
    preservedCanvas?: string;
  },
): string[] {
  assertDesignWriteAuthorized();
  if (sanitizeDesignDirectoryName(directory) !== directory)
    throw new Error("Invalid Design directory.");
  if (read(workspace, directory + "/design.toml") !== null)
    throw new Error(
      "Existing root registration must use the legacy upgrade path.",
    );
  const id = options.id;
  if (!DESIGN_DIRECTORY_ID_PATTERN.test(id))
    throw new Error("Invalid Design directory identity.");
  return buildPlan(
    workspace,
    directory,
    id,
    document,
    null,
    options,
    options.preservedCanvas,
  );
}
