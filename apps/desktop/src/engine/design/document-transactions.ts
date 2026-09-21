import { publishCloudWorkspacePath } from "../files/cloud-workspace-ownership";
import { TOKENS_SEED } from "./document-seeds";
import { MAX_DESIGN_TEXT_BYTES, utf8Bytes } from "./render-budget";
import { elementRecords } from "./source";
import {
  assertDesignWriteAuthorized,
  finishAdmittedDesignWrite,
} from "./write-authority";
// ──────────────────────────────────────────────────────────
// Design document — authored HTML/CSS frames and canvas metadata
// ──────────────────────────────────────────────────────────
//
// A design workspace is still a Git worktree, but its authored surface is one
// deliberately small directory:
//
//   Zeros Design/*.html      one top-level file per frame
//   Zeros Design/*.css       shared authored styles
//   Zeros Design/tokens.css  typed design tokens + layout reset
//   Zeros Design/design.toml  engine-managed directory registration
//   Zeros Design/canvas.json  editable scene, frame and Foundation metadata
//   Zeros Design/rules.md     short native-authoring instructions
//
// This module is the single engine-side interpretation of that format. The
// renderer and first-party MCP server both consume these functions, so frame
// discovery, OID healing, constraints, and token parsing cannot drift.

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { migrateDesignFoundationManifest } from "@zeros/design-core";
import {
  createDesignWebDocumentState,
  DESIGN_WEB_MAX_FILES,
  DESIGN_WEB_MAX_TOTAL_BYTES,
  type DesignWebDocumentState,
} from "@zeros/design-web";
import { parse } from "parse5";
import { zerosDataDir } from "../db/paths";
import { discoverDesignDirectories } from "./directory";
import { withDesignDirectoryNameLease } from "./directory-registry";
import {
  withDesignWorkspaceMutation,
  withDesignDocumentWrite as withDocumentWrite,
} from "./document-write-lock";
import {
  ensureDesignMetadataLayout,
  readDirectoryDesignManifest,
  recoverWorkspaceDesignMetadata,
} from "./metadata";

import { designDirectoryNameFor } from "./directory-registry";
import {
  type CanvasDocument,
  type DesignTransactionJournal,
} from "./document-model";
import {
  assertFrameFile,
  atomicWriteDesignSource,
  comparePortableNames,
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_WIDTH,
  designDirectory,
  discoverFrameFiles,
  isFrameFile,
  normalizeGeometry,
  readBoundedDesignFrameSource,
  readCanvas,
  readFrameMeta,
  stripLegacyFrameMeta,
  syncDirectory,
  writeCanvas,
} from "./document-storage";
import {
  designDirectoryEntry,
  designPrivateStorageDirectory,
  readDesignDirectoryRegistry,
  readDesignStorageFile,
  recoverDesignMetadataMigration,
  validateDesignSettings,
  writePrivateDesignState,
} from "./metadata";
import { readSafeRegularFile } from "./safe-files";

async function unlinkDesignArtifact(target: string): Promise<void> {
  await unlink(target);
}

export const DESIGN_TOKENS_FILE = "tokens.css";
export const DESIGN_TRANSACTION_JOURNAL_FILE = ".zeros-transaction.json";
const MAX_DESIGN_JOURNAL_BYTES = 32 * 1024 * 1024;

export async function ensureSafeDesignRoot(workspacePath: string): Promise<string> {
  const name = designDirectoryNameFor(workspacePath);
  validateDesignSettings(workspacePath, { design: { directory: name } });
  const registry = readDesignDirectoryRegistry(workspacePath);
  if (
    registry &&
    Object.keys(registry.directories).length &&
    !Object.values(registry.directories).some((entry) => entry.path === name) &&
    readDesignStorageFile(workspacePath, `${name}/.zeros-canvas.json`) === null
  )
    throw new Error(
      "The active Design directory is no longer registered in this checkout. Reopen Design before editing.",
    );
  const workspaceRoot = await realpath(path.resolve(workspacePath));
  const directory = designDirectory(workspacePath);
  await mkdir(directory, { recursive: true });
  publishCloudWorkspacePath(directory);
  const canonicalDirectory = await realpath(directory);
  // realpath the WORKSPACE root only; every design-dir segment below it must
  // be a real directory (no symlink hop), or the canonical spelling differs
  // from the expected join and the write is refused — same guard as before,
  // now covering each nested segment too.
  const expectedDirectory = path.join(
    workspaceRoot,
    ...designDirectoryNameFor(workspacePath).split("/"),
  );
  if (canonicalDirectory !== expectedDirectory) {
    throw new Error("Refusing an unsafe design write directory.");
  }
  return canonicalDirectory;
}

export async function assertSafeDesignWriteTarget(
  workspacePath: string,
  target: string,
): Promise<void> {
  const directory = designDirectory(workspacePath);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(directory, resolvedTarget);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Refusing an unsafe design write directory.");
  }
  const canonicalDirectory = await ensureSafeDesignRoot(workspacePath);
  const relativeParent = path.dirname(relative);
  const expectedParent = path.join(
    canonicalDirectory,
    relativeParent === "." ? "" : relativeParent,
  );
  let canonicalParent = canonicalDirectory;
  if (relativeParent !== ".") {
    for (const segment of relativeParent.split(path.sep)) {
      const candidate = path.join(canonicalParent, segment);
      try {
        await mkdir(candidate);
        publishCloudWorkspacePath(candidate);
      } catch (error: unknown) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (code !== "EEXIST") throw error;
      }
      const resolved = await realpath(candidate).catch(() => null);
      const info = resolved ? await stat(resolved).catch(() => null) : null;
      if (resolved !== candidate || !info?.isDirectory()) {
        throw new Error("Refusing an unsafe design write directory.");
      }
      canonicalParent = resolved;
    }
  }
  if (canonicalParent !== expectedParent) {
    throw new Error("Refusing an unsafe design write directory.");
  }
}

export async function writeIfMissing(
  file: string,
  content: string,
  created: string[],
  workspacePath: string,
): Promise<void> {
  let wrote = false;
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    publishCloudWorkspacePath(file);
    wrote = true;
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "EEXIST") throw error;
  }
  if (wrote) {
    created.push(path.relative(workspacePath, file).split(path.sep).join("/"));
  }
}

export async function initializeDesignDocumentUnlocked(
  workspacePath: string,
): Promise<void> {
  const directory = designDirectory(workspacePath);
  await ensureSafeDesignRoot(workspacePath);
  await Promise.all([
    mkdir(path.join(directory, "assets"), { recursive: true }),
    mkdir(path.join(directory, "components"), { recursive: true }),
  ]);
  publishCloudWorkspacePath(path.join(directory, "assets"));
  publishCloudWorkspacePath(path.join(directory, "components"));
  const ignored: string[] = [];
  await writeIfMissing(
    path.join(directory, DESIGN_TOKENS_FILE),
    TOKENS_SEED,
    ignored,
    workspacePath,
  );
  recoverDesignMetadataMigration(
    workspacePath,
    designDirectoryNameFor(workspacePath),
  );
  await recoverPendingDesignTransactionUnlocked(workspacePath);
  // Reading validates existing metadata as well as seeding a new document.
  const canvas = await readCanvas(workspacePath);
  if (
    !readDirectoryDesignManifest(workspacePath, designDirectoryNameFor(workspacePath))?.canvas
  )
    await writeCanvas(workspacePath, canvas);
  else
    ensureDesignMetadataLayout(
      workspacePath,
      designDirectoryNameFor(workspacePath),
    );
}

const MAX_QUARANTINED_DESIGN_TRANSACTIONS = 16;

/** Engine-owned recovery records are deliberately outside the repository so a
 * stale write-ahead journal can never be swept into a Design commit. */
export function designTransactionRecoveryDirectory(
  workspacePath: string,
): string {
  const workspaceKey = createHash("sha256")
    .update(path.resolve(workspacePath))
    .digest("hex")
    .slice(0, 32);
  return path.join(zerosDataDir(), "design-transaction-recovery", workspaceKey);
}

async function quarantineDesignRecoveryArtifact(opts: {
  workspacePath: string;
  artifactPath: string;
  reason: string;
  source: string | null;
}): Promise<void> {
  const directory = designTransactionRecoveryDirectory(opts.workspacePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const recoveryPath = path.join(
    directory,
    `${Date.now().toString().padStart(13, "0")}-${randomUUID()}.json`,
  );
  await atomicWriteDesignSource(
    recoveryPath,
    `${JSON.stringify({
      version: 1,
      workspacePath: path.resolve(opts.workspacePath),
      capturedAt: Date.now(),
      reason: opts.reason,
      artifactSource: opts.source,
    })}\n`,
  );
  await unlinkDesignArtifact(opts.artifactPath).catch((error: unknown) => {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      String(error.code) !== "ENOENT"
    ) {
      throw error;
    }
  });
  await syncDirectory(path.dirname(opts.artifactPath));

  const retained = (await readdir(directory).catch(() => []))
    .filter((candidate) => candidate.endsWith(".json"))
    .sort((left, right) => right.localeCompare(left));
  await Promise.all(
    retained
      .slice(MAX_QUARANTINED_DESIGN_TRANSACTIONS)
      .map((candidate) => {
        const target = path.join(directory, candidate);
        return rm(target, { force: true });
      }),
  );
}

async function quarantineDesignTransactionJournal(opts: {
  workspacePath: string;
  journalPath: string;
  reason: string;
  source: string | null;
}): Promise<void> {
  return quarantineDesignRecoveryArtifact({
    workspacePath: opts.workspacePath,
    artifactPath: opts.journalPath,
    reason: opts.reason,
    source: opts.source,
  });
}

async function quarantineOrphanedDesignTempsUnlocked(
  workspacePath: string,
): Promise<void> {
  const directory = designDirectory(workspacePath);
  const candidateDirectories = [directory, path.join(directory, "components")];
  for (const candidateDirectory of candidateDirectories) {
    const entries = await readdir(candidateDirectory, {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".zeros-tmp")) continue;
      const artifactPath = path.join(candidateDirectory, entry.name);
      const safe = await readSafeRegularFile(
        candidateDirectory,
        artifactPath,
        MAX_DESIGN_JOURNAL_BYTES,
      );
      await quarantineDesignRecoveryArtifact({
        workspacePath,
        artifactPath,
        reason:
          "Orphaned atomic Design write found without an active transaction.",
        source: safe ? safe.body.toString("utf8") : null,
      });
    }
  }
}

export function designTransactionJournalPath(workspacePath: string): string {
  return path.join(
    designPrivateStorageDirectory(workspacePath),
    `transaction-${designDirectoryEntry(workspacePath, designDirectoryNameFor(workspacePath))?.id ?? createHash("sha256").update(designDirectoryNameFor(workspacePath)).digest("hex").slice(0, 24)}.json`,
  );
}

function isDesignWebSourceFile(file: string, entryFile: string): boolean {
  return (
    file === entryFile ||
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.css$/i.test(file) ||
    /^components\/[a-z][a-z0-9-]*\.html$/.test(file)
  );
}

export function designWebDocumentId(frame: string): string {
  return `frame:${assertFrameFile(frame)}`;
}

async function readDesignWebDocumentStateUnlocked(
  workspacePath: string,
  frame: string,
): Promise<DesignWebDocumentState> {
  const file = assertFrameFile(frame);
  const directory = designDirectory(workspacePath);
  const entry = await readSafeRegularFile(
    directory,
    path.join(directory, file),
    MAX_DESIGN_TEXT_BYTES,
  );
  if (!entry) throw new Error(`Design frame not found: ${file}`);
  const files: Record<string, string> = {
    [file]: entry.body.toString("utf8"),
  };
  let totalSourceBytes = entry.size;
  let retainedSourceFiles = 1;
  const retainSource = (
    sourceFile: string,
    safe: { body: Buffer; size: number },
  ) => {
    if (retainedSourceFiles >= DESIGN_WEB_MAX_FILES) {
      throw new Error(
        `Design document exceeds the ${DESIGN_WEB_MAX_FILES}-file limit.`,
      );
    }
    if (totalSourceBytes + safe.size > DESIGN_WEB_MAX_TOTAL_BYTES) {
      throw new Error("Design document exceeds the total source limit.");
    }
    totalSourceBytes += safe.size;
    retainedSourceFiles += 1;
    files[sourceFile] = safe.body.toString("utf8");
  };
  const topLevel = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  for (const item of topLevel
    .filter(
      (candidate) =>
        candidate.isFile() &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*\.css$/i.test(candidate.name),
    )
    .sort((left, right) => comparePortableNames(left.name, right.name))) {
    const safe = await readSafeRegularFile(
      directory,
      path.join(directory, item.name),
      MAX_DESIGN_TEXT_BYTES,
    );
    if (safe) retainSource(item.name, safe);
  }
  const componentDirectory = path.join(directory, "components");
  const componentEntries = await readdir(componentDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  for (const item of componentEntries
    .filter(
      (candidate) =>
        candidate.isFile() && /^[a-z][a-z0-9-]*\.html$/.test(candidate.name),
    )
    .sort((left, right) => comparePortableNames(left.name, right.name))) {
    const safe = await readSafeRegularFile(
      componentDirectory,
      path.join(componentDirectory, item.name),
      MAX_DESIGN_TEXT_BYTES,
    );
    if (safe) {
      retainSource(`components/${item.name}`, safe);
    }
  }
  const canvas = await readCanvas(workspacePath);
  const components = [...canvas.foundation.components];
  const registeredComponentFiles = new Set(
    components.map((component) => component.file),
  );
  const registeredComponentIds = new Set(
    components.map((component) => component.id),
  );
  for (const componentFile of Object.keys(files)
    .filter((sourceFile) => sourceFile.startsWith("components/"))
    .sort(comparePortableNames)) {
    if (registeredComponentFiles.has(componentFile)) continue;
    const id = path.basename(componentFile, ".html");
    if (registeredComponentIds.has(id)) {
      throw new Error(
        `Legacy design component id conflicts with registered metadata: ${id}`,
      );
    }
    registeredComponentFiles.add(componentFile);
    registeredComponentIds.add(id);
    components.push({
      id,
      name: id
        .split("-")
        .filter(Boolean)
        .map((part, index) =>
          index === 0
            ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
            : part,
        )
        .join(" "),
      file: componentFile,
      props: [],
      slots: [],
    });
  }
  const foundation = migrateDesignFoundationManifest({
    ...canvas.foundation,
    components,
  });
  const meta = readFrameMeta(
    parse(files[file]!, { sourceCodeLocationInfo: true }),
    file,
    canvas,
  );
  const geometry = canvas.frames[file] ?? {
    x: 0,
    y: 0,
    w: meta.width,
    h: meta.height,
    z: 0,
  };
  return createDesignWebDocumentState({
    documentId: designWebDocumentId(file),
    entryFile: file,
    files,
    manifest: foundation,
    frames: {
      [file]: {
        x: geometry.x,
        y: geometry.y,
        width: geometry.w,
        height: geometry.h,
        z: geometry.z,
      },
    },
  });
}

function parseDesignTransactionJournal(
  workspacePath: string,
  input: unknown,
): DesignTransactionJournal {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Malformed design transaction journal.");
  }
  const journal = input as Partial<DesignTransactionJournal>;
  const entryFile = assertFrameFile(String(journal.entryFile ?? ""));
  const documentId = designWebDocumentId(entryFile);
  if (
    journal.version !== 1 ||
    journal.documentId !== documentId ||
    typeof journal.nextRevision !== "string" ||
    !/^[a-f0-9]{24}$/.test(journal.nextRevision) ||
    !Array.isArray(journal.files) ||
    journal.files.length > DESIGN_WEB_MAX_FILES
  ) {
    throw new Error("Malformed design transaction journal.");
  }
  const files = journal.files.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error("Malformed design transaction journal file.");
    }
    const record = candidate as { file?: unknown; content?: unknown };
    const file = String(record.file ?? "");
    if (!isDesignWebSourceFile(file, entryFile)) {
      throw new Error(`Invalid design transaction journal path: ${file}`);
    }
    if (
      record.content !== null &&
      (typeof record.content !== "string" ||
        Buffer.byteLength(record.content, "utf8") > MAX_DESIGN_TEXT_BYTES)
    ) {
      throw new Error(`Invalid design transaction journal content: ${file}`);
    }
    if (file === entryFile && record.content === null) {
      throw new Error("A design transaction cannot delete its entry frame.");
    }
    return { file, content: record.content as string | null };
  });
  if (new Set(files.map((file) => file.file)).size !== files.length) {
    throw new Error("Design transaction journal contains duplicate paths.");
  }
  const totalSourceBytes = files.reduce(
    (total, file) =>
      total + (file.content === null ? 0 : utf8Bytes(file.content)),
    0,
  );
  if (totalSourceBytes > 16 * 1024 * 1024) {
    throw new Error(
      "Design transaction journal exceeds the total source limit.",
    );
  }
  if (journal.before !== undefined) {
    if (
      !journal.before ||
      typeof journal.before !== "object" ||
      Array.isArray(journal.before) ||
      Object.keys(journal.before).length > DESIGN_WEB_MAX_FILES ||
      files.some(({ file }) => !Object.hasOwn(journal.before!, file)) ||
      Object.entries(journal.before).some(
        ([file, source]) =>
          !isDesignWebSourceFile(file, entryFile) ||
          (source !== null &&
            (typeof source !== "string" ||
              utf8Bytes(source) > MAX_DESIGN_TEXT_BYTES)),
      )
    )
      throw new Error("Invalid Design transaction base sources.");
  }
  if (
    (journal.canvasBeforeHash !== undefined ||
      journal.canvasAfterHash !== undefined) &&
    (!/^[a-f0-9]{64}$/.test(journal.canvasBeforeHash ?? "") ||
      !/^[a-f0-9]{64}$/.test(journal.canvasAfterHash ?? ""))
  )
    throw new Error("Invalid Design transaction metadata identity.");
  const foundation = migrateDesignFoundationManifest(journal.foundation);
  const geometry = normalizeGeometry(journal.geometry, {
    x: 0,
    y: 0,
    w: DEFAULT_FRAME_WIDTH,
    h: DEFAULT_FRAME_HEIGHT,
    z: 0,
  });
  return {
    version: 1,
    documentId,
    entryFile,
    nextRevision: journal.nextRevision,
    files,
    foundation,
    geometry,
    ...(journal.before ? { before: journal.before } : {}),
    ...(journal.canvasBeforeHash
      ? {
          canvasBeforeHash: journal.canvasBeforeHash,
          canvasAfterHash: journal.canvasAfterHash,
        }
      : {}),
  };
}

function canvasHash(canvas: CanvasDocument): string {
  return createHash("sha256").update(JSON.stringify(canvas)).digest("hex");
}

async function applyDesignTransactionJournalUnlocked(
  workspacePath: string,
  journal: DesignTransactionJournal,
): Promise<void> {
  const canvas = await readCanvas(workspacePath);
  if (
    journal.canvasBeforeHash &&
    ![journal.canvasBeforeHash, journal.canvasAfterHash].includes(
      canvasHash(canvas),
    )
  )
    throw new Error(
      "Design metadata changed since this transaction was prepared. Recovery is paused.",
    );
  if (journal.before) {
    for (const file of journal.files) {
      const current = readDesignStorageFile(
        workspacePath,
        `${designDirectoryNameFor(workspacePath)}/${file.file}`,
      );
      if (current !== journal.before[file.file] && current !== file.content)
        throw new Error(
          "Design source changed since this transaction was prepared. Recovery is paused.",
        );
    }
  }
  canvas.foundation = journal.foundation;
  canvas.frames[journal.entryFile] = {
    ...canvas.frames[journal.entryFile],
    ...journal.geometry,
  };
  await writeCanvas(
    workspacePath,
    canvas,
    journal.files.map(({ file, content }) => ({
      file: `${designDirectoryNameFor(workspacePath)}/${file}`,
      before: readDesignStorageFile(
        workspacePath,
        `${designDirectoryNameFor(workspacePath)}/${file}`,
      ),
      after: content,
    })),
  );
}

export async function recoverPendingDesignTransactionUnlocked(
  workspacePath: string,
): Promise<boolean> {
  return finishAdmittedDesignWrite(() => finishPendingDesignTransactionUnlocked(workspacePath));
}

async function finishPendingDesignTransactionUnlocked(
  workspacePath: string,
): Promise<boolean> {
  recoverDesignMetadataMigration(
    workspacePath,
    designDirectoryNameFor(workspacePath),
  );
  const privateTarget = designTransactionJournalPath(workspacePath);
  const legacyTarget = path.join(
    designDirectory(workspacePath),
    DESIGN_TRANSACTION_JOURNAL_FILE,
  );
  const oldPrivateTarget = path.join(
    designPrivateStorageDirectory(workspacePath),
    `transaction-${createHash("sha256").update(designDirectoryNameFor(workspacePath)).digest("hex").slice(0, 24)}.json`,
  );
  const candidates = [
    ...new Set([privateTarget, oldPrivateTarget, legacyTarget]),
  ].filter(existsSync);
  if (candidates.length > 1)
    throw new Error(
      "Competing Design transaction journals exist. Review their recovery records before continuing.",
    );
  const target = candidates[0] ?? privateTarget;
  const directory = path.dirname(target);
  const safe = await readSafeRegularFile(
    directory,
    target,
    MAX_DESIGN_JOURNAL_BYTES,
  );
  if (!safe) {
    if (existsSync(target)) {
      await quarantineDesignTransactionJournal({
        workspacePath,
        journalPath: target,
        reason:
          "Design transaction journal was unsafe or exceeded the 32 MiB limit.",
        source: null,
      });
    }
    await quarantineOrphanedDesignTempsUnlocked(workspacePath);
    return false;
  }
  const journalSource = safe.body.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(journalSource) as unknown;
  } catch {
    await quarantineDesignTransactionJournal({
      workspacePath,
      journalPath: target,
      reason: "Design transaction journal contained invalid JSON.",
      source: journalSource,
    });
    await quarantineOrphanedDesignTempsUnlocked(workspacePath);
    return false;
  }
  let journal: DesignTransactionJournal;
  try {
    journal = parseDesignTransactionJournal(workspacePath, parsed);
  } catch (error) {
    await quarantineDesignTransactionJournal({
      workspacePath,
      journalPath: target,
      reason: error instanceof Error ? error.message : String(error),
      source: journalSource,
    });
    await quarantineOrphanedDesignTempsUnlocked(workspacePath);
    return false;
  }
  let current: DesignWebDocumentState;
  try {
    current = await readDesignWebDocumentStateUnlocked(
      workspacePath,
      journal.entryFile,
    );
  } catch (error) {
    await quarantineDesignTransactionJournal({
      workspacePath,
      journalPath: target,
      reason: `The journal's base document could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      source: journalSource,
    });
    await quarantineOrphanedDesignTempsUnlocked(workspacePath);
    return false;
  }
  const files = { ...current.files };
  for (const change of journal.files) {
    if (change.content === null) delete files[change.file];
    else files[change.file] = change.content;
  }
  const targetState = createDesignWebDocumentState({
    documentId: journal.documentId,
    entryFile: journal.entryFile,
    files,
    manifest: journal.foundation,
    frames: {
      ...current.frames,
      [journal.entryFile]: {
        x: journal.geometry.x,
        y: journal.geometry.y,
        width: journal.geometry.w,
        height: journal.geometry.h,
        z: journal.geometry.z,
      },
    },
  });
  if (targetState.revision !== journal.nextRevision) {
    await quarantineDesignTransactionJournal({
      workspacePath,
      journalPath: target,
      reason: `Design transaction journal target revision was invalid: expected ${journal.nextRevision}, derived ${targetState.revision}.`,
      source: journalSource,
    });
    await quarantineOrphanedDesignTempsUnlocked(workspacePath);
    return false;
  }
  const migratesLegacy = !designDirectoryEntry(
    workspacePath,
    designDirectoryNameFor(workspacePath),
  );
  const expectedRevision = migratesLegacy
    ? createDesignWebDocumentState({
        ...targetState,
        files: Object.fromEntries(
          Object.entries(targetState.files).map(([file, source]) => [
            file,
            isFrameFile(file)
              ? stripLegacyFrameMeta(
                  source,
                  parse(source, { sourceCodeLocationInfo: true }),
                )
              : source,
          ]),
        ),
      }).revision
    : journal.nextRevision;
  await applyDesignTransactionJournalUnlocked(workspacePath, journal);
  const committed = await readDesignWebDocumentStateUnlocked(
    workspacePath,
    journal.entryFile,
  );
  if (committed.revision !== expectedRevision) {
    await quarantineDesignTransactionJournal({
      workspacePath,
      journalPath: target,
      reason: "Recovered design transaction did not reach its target revision.",
      source: journalSource,
    });
    await quarantineOrphanedDesignTempsUnlocked(workspacePath);
    return false;
  }
  await unlinkDesignArtifact(target).catch((error: unknown) => {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      String(error.code) !== "ENOENT"
    ) {
      throw error;
    }
  });
  await syncDirectory(path.dirname(target));
  await quarantineOrphanedDesignTempsUnlocked(workspacePath);
  return true;
}

export async function recoverPendingDesignTransaction(
  workspacePath: string,
): Promise<boolean> {
  return withDocumentWrite(workspacePath, () =>
    recoverPendingDesignTransactionUnlocked(workspacePath),
  );
}

/** Called by workspace lifecycle under the same semantic mutation lane. It
 * recovers registered documents without changing the user's active selection. */
export async function recoverDesignStorageForArchive(
  workspacePath: string,
): Promise<void> {
  await withDesignWorkspaceMutation(workspacePath, async () => {
    recoverWorkspaceDesignMetadata(workspacePath);
    for (const directory of await discoverDesignDirectories(workspacePath)) {
      if (!existsSync(path.join(workspacePath, directory))) continue;
      await withDesignDirectoryNameLease(workspacePath, directory, () =>
        recoverPendingDesignTransactionUnlocked(workspacePath),
      );
    }
  });
}

export async function readDesignWebDocumentState(
  workspacePath: string,
  frame: string,
): Promise<DesignWebDocumentState> {
  return withDocumentWrite(workspacePath, async () => {
    await recoverPendingDesignTransactionUnlocked(workspacePath);
    return readDesignWebDocumentStateUnlocked(workspacePath, frame);
  });
}

export async function commitDesignWebDocumentState(
  workspacePath: string,
  frame: string,
  expectedRevision: string,
  next: DesignWebDocumentState,
  options: { assertAuthorized?: () => void } = {},
): Promise<void> {
  const file = assertFrameFile(frame);
  await withDocumentWrite(workspacePath, async () => {
    options.assertAuthorized?.();
    await recoverPendingDesignTransactionUnlocked(workspacePath);
    // A new transaction must capture its recovery identity in the current
    // storage format. Legacy migration can change authored revisions; the
    // ordinary comparison below then asks that caller to refresh first.
    if (
      !designDirectoryEntry(
        workspacePath,
        designDirectoryNameFor(workspacePath),
      )
    )
      await initializeDesignDocumentUnlocked(workspacePath);
    const current = await readDesignWebDocumentStateUnlocked(
      workspacePath,
      file,
    );
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Design document changed: expected ${expectedRevision}, current ${current.revision}.`,
      );
    }
    if (
      next.documentId !== current.documentId ||
      next.entryFile !== current.entryFile
    ) {
      throw new Error(
        "Design transaction returned the wrong document identity.",
      );
    }
    const normalized = createDesignWebDocumentState({
      documentId: next.documentId,
      entryFile: next.entryFile,
      files: next.files,
      manifest: next.manifest,
      frames: next.frames,
    });
    if (normalized.revision !== next.revision) {
      throw new Error("Design transaction returned an invalid revision.");
    }
    const geometry = normalized.frames[file];
    if (!geometry)
      throw new Error(`Design transaction removed frame geometry: ${file}`);
    const componentFiles = new Set(
      normalized.manifest.components.map((component) => component.file),
    );
    for (const sourceFile of Object.keys(normalized.files)) {
      if (!isDesignWebSourceFile(sourceFile, file)) {
        throw new Error(
          `Design transaction returned an invalid source path: ${sourceFile}`,
        );
      }
      if (
        sourceFile.startsWith("components/") &&
        !componentFiles.has(sourceFile)
      ) {
        throw new Error(
          `Design component source is not registered: ${sourceFile}`,
        );
      }
    }
    for (const componentFile of componentFiles) {
      if (normalized.files[componentFile] === undefined) {
        throw new Error(
          `Registered design component source is missing: ${componentFile}`,
        );
      }
    }
    const nextComponentIds = new Set(
      normalized.manifest.components.map((component) => component.id),
    );
    const removedComponentIds = current.manifest.components
      .map((component) => component.id)
      .filter((componentId) => !nextComponentIds.has(componentId));
    if (removedComponentIds.length > 0) {
      const remainingHtml = Object.entries(normalized.files).filter(([name]) =>
        name.toLowerCase().endsWith(".html"),
      );
      const otherFrames = (await discoverFrameFiles(workspacePath)).filter(
        (candidate) => candidate !== file,
      );
      for (const otherFrame of otherFrames) {
        remainingHtml.push([
          otherFrame,
          await readBoundedDesignFrameSource(workspacePath, otherFrame),
        ]);
      }
      for (const componentId of removedComponentIds) {
        const owner = remainingHtml.find(([, source]) =>
          elementRecords(parse(source)).some(
            ({ element }) => element.tagName === `zd-${componentId}`,
          ),
        );
        if (owner) {
          throw new Error(
            `Design component ${componentId} still has instances in ${owner[0]}.`,
          );
        }
      }
    }
    for (const sourceFile of Object.keys(current.files)) {
      if (
        sourceFile !== file &&
        sourceFile.endsWith(".css") &&
        normalized.files[sourceFile] === undefined
      ) {
        throw new Error(
          `Design transaction cannot delete a stylesheet: ${sourceFile}`,
        );
      }
    }
    const changedFiles = new Set([
      ...Object.keys(current.files),
      ...Object.keys(normalized.files),
    ]);
    const canvasBefore = await readCanvas(workspacePath);
    const canvasAfter = {
      ...canvasBefore,
      foundation: normalized.manifest,
      frames: {
        ...canvasBefore.frames,
        [file]: {
          ...canvasBefore.frames[file],
          x: geometry.x,
          y: geometry.y,
          w: geometry.width,
          h: geometry.height,
          z: geometry.z,
        },
      },
    };
    const journal: DesignTransactionJournal = {
      version: 1,
      documentId: normalized.documentId,
      entryFile: file,
      nextRevision: normalized.revision,
      files: [...changedFiles]
        .sort(comparePortableNames)
        .filter(
          (sourceFile) =>
            current.files[sourceFile] !== normalized.files[sourceFile],
        )
        .map((sourceFile) => ({
          file: sourceFile,
          content: normalized.files[sourceFile] ?? null,
        })),
      foundation: normalized.manifest,
      geometry: {
        x: geometry.x,
        y: geometry.y,
        w: geometry.width,
        h: geometry.height,
        z: geometry.z,
      },
      before: Object.fromEntries(
        [...changedFiles]
          .filter(
            (sourceFile) =>
              current.files[sourceFile] !== normalized.files[sourceFile],
          )
          .map((sourceFile) => [sourceFile, current.files[sourceFile] ?? null]),
      ),
      canvasBeforeHash: canvasHash(canvasBefore),
      canvasAfterHash: canvasHash(canvasAfter),
    };
    const journalSource = `${JSON.stringify(journal)}\n`;
    if (utf8Bytes(journalSource) > MAX_DESIGN_JOURNAL_BYTES) {
      throw new Error("Design transaction journal exceeds the 32 MiB limit.");
    }
    await readCanvas(workspacePath);
    for (const change of journal.files) {
      await assertSafeDesignWriteTarget(
        workspacePath,
        path.join(designDirectory(workspacePath), ...change.file.split("/")),
      );
    }
    // The synchronous journal write is the commit admission point. A grant
    // revoked while validation awaited I/O must not publish a new journal.
    // Once admitted, recovery finishes that transaction even after revocation.
    options.assertAuthorized?.();
    assertDesignWriteAuthorized();
    writePrivateDesignState(
      workspacePath,
      path.basename(designTransactionJournalPath(workspacePath)),
      journalSource,
    );
    try {
      await recoverPendingDesignTransactionUnlocked(workspacePath);
    } catch (firstError) {
      // Recovery overlays the journal's complete target state before deriving
      // its revision, then rewrites every changed file and canvas metadata to
      // exact contents. Reapplying the same validated journal is therefore
      // idempotent after a partial first pass and safely retries transient I/O.
      try {
        await recoverPendingDesignTransactionUnlocked(workspacePath);
      } catch {
        throw firstError;
      }
    }
    const committed = await readDesignWebDocumentStateUnlocked(
      workspacePath,
      file,
    );
    if (committed.revision !== normalized.revision) {
      throw new Error("Design transaction did not commit its exact revision.");
    }
  });
}
