// Bench only: engine-side costs of recording a page (compose, store, read).
// bun scripts/phase1-engine-probe.ts <workspace> <page-prefix> <frames>
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { writeFile } from "node:fs/promises";
import { readDesignNavigationSnapshot, prepareDesignNavigationFrames } from "../apps/desktop/src/engine/design/document";
import { readSharedCanvasContext } from "../apps/desktop/src/engine/design/document-storage";
import { designDirectoryNameFor } from "../apps/desktop/src/engine/design/directory-registry";
import { designDirectoryEntry } from "../apps/desktop/src/engine/design/metadata";
import { composeDesignThumbnailBatches } from "../apps/desktop/src/engine/design/thumbnail-batch";
import { designBatchRecordRequestFrom } from "../apps/desktop/src/engine/design/recording-batch";

const [workspace, page, count] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? "64")];
const t0 = performance.now();
const directoryId = designDirectoryEntry(workspace, designDirectoryNameFor(workspace))!.id;
const { canvas } = await readSharedCanvasContext(workspace);
const files = Object.keys(canvas.frame_info).filter((file) => file.startsWith(`${page}/`)).sort().slice(0, count);
const t1 = performance.now();
const navigation = await readDesignNavigationSnapshot(workspace);
const frames: Array<{ file: string; sourceVersion: string }> = [];
for (let at = 0; at < files.length; at += 16)
  for (const entry of (await prepareDesignNavigationFrames(workspace, navigation.catalogRevision, files.slice(at, at + 16))).frames)
    if (entry.sourceVersion) frames.push({ file: entry.file, sourceVersion: entry.sourceVersion });
const t2 = performance.now();
const profile = process.env.PROBE_PROFILE ? new Session() : null;
if (profile) { profile.connect(); await profile.post("Profiler.enable"); await profile.post("Profiler.setSamplingInterval", { interval: 500 }); await profile.post("Profiler.start"); }
let composedFrames = 0, htmlBytes = 0, sheetBytes = 0, batches = 0;
const composeTimes: number[] = [];
const SLICE = Number(process.env.PROBE_SLICE ?? "64");
for (let at = 0; at < frames.length; at += SLICE) {
  const started = performance.now();
  const composed = await composeDesignThumbnailBatches(workspace, { workspaceId: "probe", directoryId, theme: null, colorScheme: "light", maxDimension: 256, frames: frames.slice(at, at + SLICE) });
  composeTimes.push(performance.now() - started);
  for (const batch of composed.batches) {
    batches++;
    const request = designBatchRecordRequestFrom(batch.request);
    composedFrames += request.items.length;
    htmlBytes += request.items.reduce((n, item) => n + item.html.length, 0);
    sheetBytes += Object.values(request.stylesheets).reduce((n, css) => n + css.length, 0);
  }
}
const t3 = performance.now();
if (profile) { const { profile: cpu } = await profile.post("Profiler.stop"); await writeFile(process.env.PROBE_PROFILE!, JSON.stringify(cpu)); }
console.log(JSON.stringify({ files: files.length, catalogMs: Math.round(t1 - t0), prepareMs: Math.round(t2 - t1), prepared: frames.length,
  composeMs: Math.round(t3 - t2), composePerFrameMs: +((t3 - t2) / Math.max(1, composedFrames)).toFixed(2), composeCallsMs: composeTimes.map(Math.round),
  batches, composedFrames, htmlKBPerFrame: Math.round(htmlBytes / Math.max(1, composedFrames) / 1024), sheetKBPerBatch: Math.round(sheetBytes / Math.max(1, batches) / 1024) }));
