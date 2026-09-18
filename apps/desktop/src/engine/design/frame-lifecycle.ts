import { escapeText, insertDesignHeadMarkup } from "./source";
import { FRAME_SEED, TEXT_FRAME_SEED } from "./document-seeds";
import { designNodeRecords, healDesignOids } from "./node-identities";
import {
  DesignRenderBudgetError,
  MAX_DESIGN_TEXT_BYTES,
  utf8Bytes,
} from "./render-budget";
import { prepareFrameRenderSource } from "./render-preparation";
import { elementRecords } from "./source";
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
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  createDesignWebDocumentState,
  mutateDesignNodeAttributeSource,
  mutateDesignNodeDeleteSource,
  mutateDesignNodeHtmlSource,
  mutateDesignNodeMoveSource,
  mutateDesignNodeStyles,
} from "@zeros/design-web";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { withDesignDocumentWrite as withDocumentWrite } from "./document-write-lock";

import { designDirectoryNameFor } from "./directory-registry";
import {
  type DesignFrameChange,
  type DesignFrameGeometry,
  type DesignFrameMutationInput,
  type DesignFrameRenderIdentity,
  type DesignFrameRestorePoint,
  type DesignFrameSummary,
  type DesignReadOptions,
  type FrameMeta,
} from "./document-model";
import {
  assertFrameFile,
  atomicWriteDesignSource,
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_WIDTH,
  designDirectory,
  discoverFrameFiles,
  MAX_FRAME_COUNT,
  nextFrameGeometry,
  normalizeGeometry,
  readBoundedDesignFrameSource,
  readCanvas,
  readFrameMeta,
  stripLegacyFrameMeta,
  writeCanvas,
} from "./document-storage";
import {
  assertSafeDesignWriteTarget,
  initializeDesignDocumentUnlocked,
} from "./document-transactions";
import { type DesignStorageChange } from "./metadata";
import { legacyFrameId } from "./canvas-file";
import { isDeepStrictEqual } from "node:util";

function slugFrameTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "frame";
}

export async function createDesignFrame(
  workspacePath: string,
  input: {
    title?: string;
    geometry?: Partial<DesignFrameGeometry>;
    seed?: {
      kind: "text";
      nodeId: string;
      text: string;
      fixedSize: boolean;
    };
  } = {},
): Promise<DesignFrameSummary> {
  return withDocumentWrite(workspacePath, async () => {
    await initializeDesignDocumentUnlocked(workspacePath);
    const directory = designDirectory(workspacePath);
    const title = input.title?.trim().slice(0, 120) || "Frame";
    const base = slugFrameTitle(title);
    let file = `${base}.html`;
    for (let suffix = 2; existsSync(path.join(directory, file)); suffix++) {
      file = `${base}-${suffix}.html`;
    }
    const oid = `f-${createHash("sha256")
      .update(`${file}:${Date.now()}:${randomUUID()}`)
      .digest("hex")
      .slice(0, 8)}`;
    const canvas = await readCanvas(workspacePath);
    const automaticGeometry = nextFrameGeometry(Object.values(canvas.frames), {
      width: DEFAULT_FRAME_WIDTH,
      height: DEFAULT_FRAME_HEIGHT,
    });
    const geometry = input.geometry
      ? normalizeGeometry(input.geometry, automaticGeometry)
      : automaticGeometry;
    const textSeed = input.seed;
    if (textSeed && textSeed.text.length > 10_000) {
      throw new Error("Design text is too long.");
    }
    const source = textSeed
      ? TEXT_FRAME_SEED(
          title,
          assertDesignNodeId(textSeed.nodeId),
          textSeed.text,
          geometry.w,
          geometry.h,
          textSeed.fixedSize,
        )
      : FRAME_SEED(title, oid, geometry.w, geometry.h);
    canvas.frames[file] = geometry;
    canvas.frame_info[file] = { id: `frame_${randomUUID().replace(/-/g, "")}`, title, kind: textSeed ? "text" : "frame" };
    await writeCanvas(workspacePath, canvas, [
      {
        file: `${designDirectoryNameFor(workspacePath)}/${file}`,
        before: null,
        after: source,
      },
    ]);
    const info = await stat(path.join(directory, file));
    return {
      file,
      title,
      kind: textSeed ? "text" : "frame",
      width: geometry.w,
      height: geometry.h,
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      nodeCount: 1,
      modifiedAt: info.mtimeMs,
    };
  });
}



export { healDesignOids } from "./node-identities";

export async function designFrameTarget(
  workspacePath: string,
  frame: string,
): Promise<{ file: string; target: string }> {
  const file = assertFrameFile(frame);
  if (!(await discoverFrameFiles(workspacePath)).includes(file)) {
    throw new Error(`Design frame not found: ${file}`);
  }
  return {
    file,
    target: path.join(designDirectory(workspacePath), file),
  };
}

async function readAndHealFrame(
  workspacePath: string,
  file: string,
  heal = true,
): Promise<{ source: string; healed: number }> {
  const target = path.join(
    designDirectory(workspacePath),
    assertFrameFile(file),
  );
  const source = await readBoundedDesignFrameSource(workspacePath, file);
  if (!heal) return { source, healed: 0 };
  const healed = healDesignOids(source);
  if (healed.changed) await atomicWriteDesignSource(target, healed.html);
  return { source: healed.html, healed: healed.fixed.length };
}

export async function listDesignFramesUnlocked(
  workspacePath: string,
  writeBack: boolean,
): Promise<DesignFrameSummary[]> {
  if (writeBack) await initializeDesignDocumentUnlocked(workspacePath);
  const files = await discoverFrameFiles(workspacePath);
  const canvas = await readCanvas(workspacePath);
  let canvasChanged = false;
  const sourceChanges: DesignStorageChange[] = [];
  const summaries: DesignFrameSummary[] = [];
  for (const file of files) {
    let source: string;
    try {
      ({ source } = await readAndHealFrame(workspacePath, file, writeBack));
    } catch (error) {
      if (!existsSync(path.join(designDirectory(workspacePath), file)))
        throw new Error(`Design frame source is missing: ${file}. Update canvas.json or restore the file.`);
      if (error instanceof DesignRenderBudgetError) continue;
      throw error;
    }
    const document = parse(source, { sourceCodeLocationInfo: true });
    const meta = readFrameMeta(document, file, canvas);
    if (writeBack) {
      const after = stripLegacyFrameMeta(source, document);
      if (after !== source)
        sourceChanges.push({
          file: `${designDirectoryNameFor(workspacePath)}/${file}`,
          before: source,
          after,
        });
    }
    if (!canvas.frame_info[file]) {
      canvas.frame_info[file] = { title: meta.title, kind: meta.kind };
      canvasChanged = true;
    }
    let geometry = canvas.frames[file];
    if (!geometry) {
      geometry = nextFrameGeometry(Object.values(canvas.frames), meta);
      canvas.frames[file] = geometry;
      canvasChanged = true;
    }
    const info = await stat(path.join(designDirectory(workspacePath), file));
    summaries.push({
      file,
      title: meta.title,
      kind: meta.kind,
      width: geometry.w,
      height: geometry.h,
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      nodeCount: designNodeRecords(document).length,
      modifiedAt: info.mtimeMs,
    });
  }
  const live = new Set(files);
  for (const file of Object.keys(canvas.frames)) {
    if (live.has(file)) continue;
    delete canvas.frames[file];
    delete canvas.frame_info[file];
    canvasChanged = true;
  }
  if (writeBack && (canvasChanged || sourceChanges.length))
    await writeCanvas(workspacePath, canvas, sourceChanges);
  return summaries.sort((left, right) => left.z - right.z);
}

export async function listDesignFrames(
  workspacePath: string,
  options: DesignReadOptions = {},
): Promise<DesignFrameSummary[]> {
  const writeBack = options.writeBack === true;
  return writeBack
    ? withDocumentWrite(workspacePath, () =>
        listDesignFramesUnlocked(workspacePath, true),
      )
    : listDesignFramesUnlocked(workspacePath, false);
}

export async function updateDesignFrameGeometry(
  workspacePath: string,
  frame: string,
  geometry: Partial<DesignFrameGeometry>,
): Promise<DesignFrameGeometry> {
  return withDocumentWrite(workspacePath, async () => {
    const { file } = await designFrameTarget(workspacePath, frame);
    const canvas = await readCanvas(workspacePath);
    const current = canvas.frames[file] ?? {
      x: 0,
      y: 0,
      w: DEFAULT_FRAME_WIDTH,
      h: DEFAULT_FRAME_HEIGHT,
      z: Object.keys(canvas.frames).length,
    };
    const next = normalizeGeometry({ ...current, ...geometry }, current);
    canvas.frames[file] = next;
    await writeCanvas(workspacePath, canvas);
    return next;
  });
}

/** Change the separate frame title and keep an existing HTML <title> in sync.
 * The source edit is a byte-range splice; unrelated formatting is retained. */
export async function renameDesignFrame(
  workspacePath: string,
  frame: string,
  nextTitle: string,
): Promise<DesignFrameSummary> {
  const file = assertFrameFile(frame);
  const title = nextTitle.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!title) throw new Error("Design frame title cannot be empty.");

  await withDocumentWrite(workspacePath, async () => {
    await designFrameTarget(workspacePath, file);
    const source = await readBoundedDesignFrameSource(workspacePath, file);
    const canvas = await readCanvas(workspacePath);
    const meta = readFrameMeta(
      parse(source, { sourceCodeLocationInfo: true }),
      file,
      canvas,
    );
    canvas.frame_info[file] = {
      ...canvas.frame_info[file],
      title,
      kind: meta.kind,
    };
    const updated = rewriteFrameTitleSource(source, title);
    await writeCanvas(workspacePath, canvas, [
      {
        file: `${designDirectoryNameFor(workspacePath)}/${file}`,
        before: source,
        after: updated,
      },
    ]);
  });

  const summary = (await listDesignFrames(workspacePath)).find(
    (candidate) => candidate.file === file,
  );
  if (!summary) throw new Error(`Design frame not found: ${file}`);
  return summary;
}

export function hasDesignControlCharacter(
  value: string,
  allowTextWhitespace = false,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 127) return true;
    if (
      code < 32 &&
      (!allowTextWhitespace || (code !== 9 && code !== 10 && code !== 13))
    ) {
      return true;
    }
  }
  return false;
}

export function assertDesignNodeId(value: string): string {
  const nodeId = value.trim();
  if (!nodeId || nodeId.length > 256 || hasDesignControlCharacter(nodeId)) {
    throw new Error("nodeId must be a stable non-empty data-oid.");
  }
  return nodeId;
}

function rewriteFrameTitleSource(source: string, title: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const { element } of elementRecords(document)) {
    if (element.tagName !== "title") continue;
    const location = element.sourceCodeLocation;
    if (location?.startTag && location.endTag)
      edits.push({
        start: location.startTag.endOffset,
        end: location.endTag.startOffset,
        text: escapeText(title),
      });
  }
  let updated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    updated =
      updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  return stripLegacyFrameMeta(
    updated,
    parse(updated, { sourceCodeLocationInfo: true }),
  );
}

function reseedFrameOids(source: string, salt: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let index = 0;
  for (const { element, oid } of designNodeRecords(document)) {
    const location = element.sourceCodeLocation?.attrs?.["data-oid"];
    if (!oid || !location) continue;
    const next = `o-${createHash("sha256")
      .update(`${salt}:${index++}:${oid}`)
      .digest("hex")
      .slice(0, 9)}`;
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      text: `data-oid="${next}"`,
    });
  }
  let updated = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    updated = `${updated.slice(0, edit.start)}${edit.text}${updated.slice(edit.end)}`;
  }
  return updated;
}

export async function duplicateDesignFrame(
  workspacePath: string,
  frame: string,
): Promise<DesignFrameSummary> {
  const originalFile = assertFrameFile(frame);
  return withDocumentWrite(workspacePath, async () => {
    await designFrameTarget(workspacePath, originalFile);
    const original = await readBoundedDesignFrameSource(
      workspacePath,
      originalFile,
    );
    const originalMeta = readFrameMeta(
      parse(original, { sourceCodeLocationInfo: true }),
      originalFile,
      await readCanvas(workspacePath),
    );
    const title = `${originalMeta.title} copy`.slice(0, 120);
    const directory = designDirectory(workspacePath);
    const base = `${slugFrameTitle(originalMeta.title)}-copy`;
    let file = `${base}.html`;
    for (let suffix = 2; existsSync(path.join(directory, file)); suffix += 1) {
      file = `${base}-${suffix}.html`;
    }
    const source = reseedFrameOids(
      rewriteFrameTitleSource(original, title),
      `${file}:${randomUUID()}`,
    );
    const canvas = await readCanvas(workspacePath);
    const geometry = nextFrameGeometry(
      Object.values(canvas.frames),
      originalMeta,
    );
    canvas.frames[file] = geometry;
    canvas.frame_info[file] = { id: `frame_${randomUUID().replace(/-/g, "")}`, title, kind: originalMeta.kind };
    await writeCanvas(workspacePath, canvas, [
      {
        file: `${designDirectoryNameFor(workspacePath)}/${file}`,
        before: null,
        after: source,
      },
    ]);
    const info = await stat(path.join(directory, file));
    return {
      file,
      title,
      kind: originalMeta.kind,
      width: geometry.w,
      height: geometry.h,
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      nodeCount: designNodeRecords(parse(source)).length,
      modifiedAt: info.mtimeMs,
    };
  });
}

async function designFrameRestorePointUnlocked(
  workspacePath: string,
  frame: string,
): Promise<{ target: string; restorePoint: DesignFrameRestorePoint }> {
  const file = assertFrameFile(frame);
  const { target } = await designFrameTarget(workspacePath, file);
  const source = await readBoundedDesignFrameSource(workspacePath, file);
  const meta = readFrameMeta(
    parse(source, { sourceCodeLocationInfo: true }),
    file,
    await readCanvas(workspacePath),
  );
  const canvas = await readCanvas(workspacePath);
  const geometry = canvas.frames[file] ?? {
    x: 0,
    y: 0,
    w: meta.width,
    h: meta.height,
    z: Object.keys(canvas.frames).length,
  };
  return {
    target,
    restorePoint: {
      file,
      source,
      geometry: { ...geometry },
      metadata: { ...canvas.frame_info[file], title: meta.title, kind: meta.kind },
    },
  };
}

export function sameDesignFrameRestorePoint(
  left: DesignFrameRestorePoint,
  right: DesignFrameRestorePoint,
): boolean {
  return (
    left.file === right.file &&
    left.source === right.source &&
    isDeepStrictEqual(
      { ...left.metadata, id: (left.metadata as FrameMeta | undefined)?.id ?? legacyFrameId(left.file) },
      { ...right.metadata, id: (right.metadata as FrameMeta | undefined)?.id ?? legacyFrameId(right.file) },
    ) &&
    left.geometry.x === right.geometry.x &&
    left.geometry.y === right.geometry.y &&
    left.geometry.w === right.geometry.w &&
    left.geometry.h === right.geometry.h &&
    left.geometry.z === right.geometry.z
  );
}

/** Capture the byte-exact source and canvas geometry needed by structural
 * history. This intentionally avoids render composition and OID healing. */
export async function captureDesignFrameRestorePoint(
  workspacePath: string,
  frame: string,
): Promise<DesignFrameRestorePoint> {
  return withDocumentWrite(
    workspacePath,
    async () =>
      (await designFrameRestorePointUnlocked(workspacePath, frame))
        .restorePoint,
  );
}

export async function deleteDesignFrame(
  workspacePath: string,
  frame: string,
  expected?: DesignFrameRestorePoint,
): Promise<DesignFrameRestorePoint> {
  const file = assertFrameFile(frame);
  return withDocumentWrite(workspacePath, async () => {
    const { restorePoint } = await designFrameRestorePointUnlocked(
      workspacePath,
      file,
    );
    if (expected && !sameDesignFrameRestorePoint(restorePoint, expected)) {
      throw new Error(`Design frame changed after this history entry: ${file}`);
    }
    const canvas = await readCanvas(workspacePath);
    delete canvas.frames[file];
    delete canvas.frame_info[file];
    await writeCanvas(workspacePath, canvas, [
      {
        file: `${designDirectoryNameFor(workspacePath)}/${file}`,
        before: restorePoint.source,
        after: null,
      },
    ]);
    return restorePoint;
  });
}

/** Restore an exact frame deletion without generating new identities or
 * changing its source formatting. This is the inverse used by Command-Z. */
export async function restoreDesignFrame(
  workspacePath: string,
  restorePoint: DesignFrameRestorePoint,
): Promise<DesignFrameSummary> {
  const file = assertFrameFile(restorePoint.file);
  if (
    typeof restorePoint.source !== "string" ||
    utf8Bytes(restorePoint.source) > MAX_DESIGN_TEXT_BYTES
  ) {
    throw new Error(`Design frame restore source is invalid: ${file}`);
  }
  return withDocumentWrite(workspacePath, async () => {
    await initializeDesignDocumentUnlocked(workspacePath);
    const directory = designDirectory(workspacePath);
    const target = path.join(directory, file);
    await assertSafeDesignWriteTarget(workspacePath, target);
    const document = parse(restorePoint.source, {
      sourceCodeLocationInfo: true,
    });
    const meta = { ...readFrameMeta(document, file), ...restorePoint.metadata };
    const canvas = await readCanvas(workspacePath);
    if (
      !Object.prototype.hasOwnProperty.call(canvas.frames, file) &&
      Object.keys(canvas.frames).length >= MAX_FRAME_COUNT
    ) {
      throw new Error(`Design document exceeds ${MAX_FRAME_COUNT} frames.`);
    }
    const geometry = normalizeGeometry(restorePoint.geometry, {
      x: 0,
      y: 0,
      w: meta.width,
      h: meta.height,
      z: Object.keys(canvas.frames).length,
    });
    if (existsSync(target))
      throw new Error(`Design frame already exists: ${file}`);
    canvas.frames[file] = geometry;
    canvas.frame_info[file] = restorePoint.metadata ?? {
      title: meta.title,
      kind: meta.kind,
    };
    await writeCanvas(workspacePath, canvas, [
      {
        file: `${designDirectoryNameFor(workspacePath)}/${file}`,
        before: null,
        after: restorePoint.source,
      },
    ]);
    const info = await stat(target);
    return {
      file,
      title: meta.title,
      kind: meta.kind,
      width: geometry.w,
      height: geometry.h,
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      nodeCount: designNodeRecords(document).length,
      modifiedAt: info.mtimeMs,
    };
  });
}

async function applyDesignFrameChangesUnlocked(
  workspacePath: string,
  changes: readonly DesignFrameChange[],
): Promise<void> {
  if (changes.length < 1 || changes.length > 2)
    throw new Error("Invalid frame transfer size.");
  const canvas = await readCanvas(workspacePath);
  const sourceChanges: DesignStorageChange[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const file = assertFrameFile(
      change.before?.file ?? change.after?.file ?? "",
    );
    if (
      seen.has(file) ||
      (change.before &&
        change.after &&
        change.before.file !== change.after.file)
    )
      throw new Error("Invalid frame transfer identity.");
    seen.add(file);
    const target = path.join(designDirectory(workspacePath), file);
    await assertSafeDesignWriteTarget(workspacePath, target);
    if (change.before) {
      const { restorePoint } = await designFrameRestorePointUnlocked(
        workspacePath,
        file,
      );
      if (!sameDesignFrameRestorePoint(restorePoint, change.before))
        throw new Error("The frame changed before the layer move.");
    } else if (existsSync(target))
      throw new Error("The destination frame already exists.");
    if (change.after) {
      if (utf8Bytes(change.after.source) > MAX_DESIGN_TEXT_BYTES)
        throw new Error("The destination frame is too large.");
      canvas.frames[file] = normalizeGeometry(
        change.after.geometry,
        change.after.geometry,
      );
      canvas.frame_info[file] = change.after.metadata ?? {
        title: "Frame",
        kind: "frame",
      };
    } else {
      delete canvas.frames[file];
      delete canvas.frame_info[file];
    }
    sourceChanges.push({
      file: `${designDirectoryNameFor(workspacePath)}/${file}`,
      before: change.before?.source ?? null,
      after: change.after?.source ?? null,
    });
  }
  if (Object.keys(canvas.frames).length > MAX_FRAME_COUNT)
    throw new Error("The canvas has too many frames.");
  // The metadata journal publishes both source files and geometry as one
  // recoverable Design storage transaction. No half-detached layer is visible.
  await writeCanvas(workspacePath, canvas, sourceChanges);
}

export async function restoreDesignFrameChanges(
  workspacePath: string,
  changes: readonly DesignFrameChange[],
  direction: "undo" | "redo",
): Promise<void> {
  return withDocumentWrite(workspacePath, () =>
    applyDesignFrameChangesUnlocked(
      workspacePath,
      direction === "undo"
        ? changes.map(({ before, after }) => ({ before: after, after: before }))
        : changes,
    ),
  );
}

/** The Design surface owns cross-document moves. Source is extracted inside
 * the engine; the renderer supplies only identities, geometry and CSS values. */
export async function transferDesignNode(
  workspacePath: string,
  input: DesignFrameMutationInput & {
    destinationFrame?: string;
    destinationSourceVersion?: string;
    parentId?: string;
    beforeId?: string | null;
    styles?: Record<string, string | null>;
    geometry: DesignFrameGeometry;
  },
): Promise<{ frame: string; nodeId: string; changes: DesignFrameChange[] }> {
  return withDocumentWrite(workspacePath, async () => {
    const { restorePoint: from } = await designFrameRestorePointUnlocked(
      workspacePath,
      input.frame,
    );
    const identity = await readDesignFrameRenderIdentityFromSource(
      workspacePath,
      from.file,
      from.source,
    );
    if (identity.sourceVersion !== input.sourceVersion)
      throw new Error("The source frame changed before the layer move.");
    if (input.destinationFrame === from.file)
      throw new Error("Use a node move for layers in the same frame.");
    const fromSource = healDesignOids(from.source).html;
    const sourceDocument = parse(fromSource, { sourceCodeLocationInfo: true });
    const record = designNodeRecords(sourceDocument).find(
      (record) => record.oid === input.nodeId,
    );
    const span = record?.element.sourceCodeLocation;
    if (!record || !span)
      throw new Error("The layer has no movable source span.");
    let fragment = fromSource.slice(span.startOffset, span.endOffset);
    const root = record.element.attrs.some(
      (attribute) => attribute.name === "data-zeros-frame-root",
    );
    const body = elementRecords(sourceDocument).find(
      ({ element }) => element.tagName === "body",
    )?.element;
    const bodySpan = body?.sourceCodeLocation;
    if (!bodySpan?.startTag || !bodySpan.endTag)
      throw new Error("The source frame needs an explicit body.");
    const removeFrame =
      root &&
      body?.childNodes.filter(
        (child) =>
          "tagName" in child &&
          child.attrs.some((attribute) => attribute.name === "data-oid"),
      ).length === 1;
    const remaining = removeFrame
      ? null
      : {
          ...from,
          source: mutateDesignNodeDeleteSource(fromSource, input.nodeId),
        };
    let destination: DesignFrameRestorePoint | null = null;
    let after: DesignFrameRestorePoint;
    if (input.destinationFrame) {
      destination = (
        await designFrameRestorePointUnlocked(
          workspacePath,
          input.destinationFrame,
        )
      ).restorePoint;
      const destinationIdentity = await readDesignFrameRenderIdentityFromSource(
        workspacePath,
        destination.file,
        destination.source,
      );
      if (destinationIdentity.sourceVersion !== input.destinationSourceVersion)
        throw new Error("The destination frame changed before the layer move.");
      const destinationSource = healDesignOids(destination.source).html;
      const destinationIds = new Set(
        designNodeRecords(parse(destinationSource)).map(
          (record) => record.oid,
        ),
      );
      if (
        designNodeRecords(parse(fragment)).some(
          (record) => record.oid && destinationIds.has(record.oid),
        )
      )
        throw new Error(
          "The destination already contains one of these layer identities.",
        );
      fragment = mutateDesignNodeAttributeSource(
        fragment,
        input.nodeId,
        "data-zeros-frame-root",
        null,
      );
      let source = mutateDesignNodeHtmlSource(
        destinationSource,
        input.parentId ?? "::zeros-document-body",
        fragment,
        "append",
      );
      if (input.beforeId)
        source = mutateDesignNodeMoveSource(
          source,
          input.nodeId,
          input.parentId ?? "::zeros-document-body",
          input.beforeId,
        );
      // Keep local stylesheet dependencies when a detached frame is put back.
      // They remain relative to the same Design directory.
      const dependencies = elementRecords(sourceDocument)
        .filter(
          ({ element }) =>
            element.tagName === "style" ||
            (element.tagName === "link" &&
              element.attrs.some(
                (attribute) =>
                  attribute.name === "rel" && attribute.value === "stylesheet",
              )),
        )
        .flatMap(({ element }) => {
          const location = element.sourceCodeLocation;
          if (
            !location ||
            (location.startOffset >= span.startOffset &&
              location.endOffset <= span.endOffset)
          )
            return [];
          const content = fromSource.slice(
            location.startOffset,
            location.endOffset,
          );
          return source.includes(content) ? [] : [content];
        });
      if (dependencies.length)
        source = insertDesignHeadMarkup(source, dependencies.join("\n"));
      after = { ...destination, source };
    } else {
      const base = "frame";
      let file = `${base}.html`;
      for (
        let suffix = 2;
        existsSync(path.join(designDirectory(workspacePath), file));
        suffix++
      )
        file = `${base}-${suffix}.html`;
      fragment = mutateDesignNodeAttributeSource(
        fragment,
        input.nodeId,
        "data-zeros-frame-root",
        "",
      );
      after = {
        file,
        source:
          fromSource.slice(0, bodySpan.startTag.endOffset) +
          fragment +
          fromSource.slice(bodySpan.endTag.startOffset),
        geometry: normalizeGeometry(input.geometry, input.geometry),
        metadata: { id: `frame_${randomUUID().replace(/-/g, "")}`, title: "Frame", kind: "frame" },
      };
    }
    const styles = input.destinationFrame
      ? (input.styles ?? {})
      : {
          ...input.styles,
          position: "relative",
          left: "auto",
          top: "auto",
          right: "auto",
          bottom: "auto",
          width: "100%",
          height: "100vh",
          "flex-grow": "0",
          "flex-shrink": "0",
          "flex-basis": "auto",
        };
    if (Object.keys(styles).length) {
      const state = createDesignWebDocumentState({
        documentId: "transfer",
        entryFile: after.file,
        files: { [after.file]: after.source },
      });
      after.source = mutateDesignNodeStyles(state, {
        nodeId: input.nodeId,
        styles,
        scope: "inline",
      }).files[after.file]!;
    }
    const changes = [
      { before: from, after: remaining },
      { before: destination, after },
    ];
    await applyDesignFrameChangesUnlocked(workspacePath, changes);
    return { frame: after.file, nodeId: input.nodeId, changes };
  });
}

/** Replace one present frame with an exact prior/later history state. The
 * expected state makes stale undo/redo fail closed instead of overwriting an
 * out-of-band source change. */
export async function replaceDesignFrameFromHistory(
  workspacePath: string,
  expected: DesignFrameRestorePoint,
  replacement: DesignFrameRestorePoint,
): Promise<DesignFrameSummary> {
  const file = assertFrameFile(expected.file);
  if (assertFrameFile(replacement.file) !== file) {
    throw new Error("Design frame history cannot change file identity.");
  }
  if (
    typeof replacement.source !== "string" ||
    utf8Bytes(replacement.source) > MAX_DESIGN_TEXT_BYTES
  ) {
    throw new Error(`Design frame restore source is invalid: ${file}`);
  }
  return withDocumentWrite(workspacePath, async () => {
    const { target, restorePoint: current } =
      await designFrameRestorePointUnlocked(workspacePath, file);
    if (!sameDesignFrameRestorePoint(current, expected)) {
      throw new Error(`Design frame changed after this history entry: ${file}`);
    }
    const document = parse(replacement.source, {
      sourceCodeLocationInfo: true,
    });
    const meta = { ...readFrameMeta(document, file), ...replacement.metadata };
    const geometry = normalizeGeometry(replacement.geometry, current.geometry);
    const canvas = await readCanvas(workspacePath);
    canvas.frames[file] = geometry;
    canvas.frame_info[file] = replacement.metadata ?? {
      title: meta.title,
      kind: meta.kind,
    };
    await writeCanvas(workspacePath, canvas, [
      {
        file: `${designDirectoryNameFor(workspacePath)}/${file}`,
        before: current.source,
        after: replacement.source,
      },
    ]);
    const info = await stat(target);
    return {
      file,
      title: meta.title,
      kind: meta.kind,
      width: geometry.w,
      height: geometry.h,
      x: geometry.x,
      y: geometry.y,
      z: geometry.z,
      nodeCount: designNodeRecords(document).length,
      modifiedAt: info.mtimeMs,
    };
  });
}

export async function prepareFrameRenderSourceForFile(
  workspacePath: string,
  file: string,
  source: string,
): Promise<{
  document: DefaultTreeAdapterTypes.Document;
  meta: FrameMeta;
  width: number;
  height: number;
  x: number;
  y: number;
  sanitized: string;
  sourceVersion: string;
}> {
  const document = parse(healDesignOids(source).html, { sourceCodeLocationInfo: true });
  const canvas = await readCanvas(workspacePath);
  const meta = readFrameMeta(document, file, canvas);
  const geometry = canvas.frames[file];
  const width = geometry?.w ?? meta.width;
  const height = geometry?.h ?? meta.height;
  const render = await prepareFrameRenderSource(workspacePath, source, {
    width,
    height,
  });
  return {
    document,
    meta,
    width,
    height,
    x: geometry?.x ?? 0,
    y: geometry?.y ?? 0,
    ...render,
  };
}

/** Hash the exact frame bytes already obtained from a verified descriptor. */
export async function readDesignFrameRenderIdentityFromSource(
  workspacePath: string,
  frame: string,
  source: string,
): Promise<DesignFrameRenderIdentity> {
  const file = assertFrameFile(frame);
  const render = await prepareFrameRenderSourceForFile(
    workspacePath,
    file,
    source,
  );
  return { file, sourceVersion: render.sourceVersion };
}
