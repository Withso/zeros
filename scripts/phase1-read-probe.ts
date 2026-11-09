// Bench only: the reopen path. Reads every stored recording of a page the way
// the canvas does (version-less, 256 frames per request, chunks it holds named).
// node .probe/read-probe.mjs <workspace> <page-prefix> [repeat]
import { performance } from "node:perf_hooks";
import { readSharedCanvasContext } from "../apps/desktop/src/engine/design/document-storage";
import { designDirectoryNameFor } from "../apps/desktop/src/engine/design/directory-registry";
import { designDirectoryEntry } from "../apps/desktop/src/engine/design/metadata";
import { readDesignRecordings } from "../apps/desktop/src/engine/design/recording-batch";

const [workspace, page, repeat] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? "2")];
const directoryId = designDirectoryEntry(workspace, designDirectoryNameFor(workspace))!.id;
const { canvas } = await readSharedCanvasContext(workspace);
const files = Object.keys(canvas.frame_info).filter((file) => file.startsWith(`${page}/`)).sort();
for (let pass = 0; pass < repeat; pass++) {
  const known: string[] = [];
  const times: number[] = [];
  let recordings = 0, chunkBytes = 0, deferred = 0, missing = 0, requests = 0;
  let queue = files.map((file) => ({ file }));
  const started = performance.now();
  while (queue.length && requests < 64) {
    const batch = queue.slice(0, 256);
    const t = performance.now();
    const reply = await readDesignRecordings(workspace, { workspaceId: "probe", directoryId, theme: null, frames: batch, knownChunks: known.slice(-4096) });
    times.push(Math.round(performance.now() - t));
    requests++;
    recordings += reply.recordings.length; deferred += reply.deferred.length; missing += reply.missing.length;
    for (const chunk of reply.chunks) { known.push(chunk.id); chunkBytes += chunk.data.length; }
    const again = new Set(reply.deferred);
    queue = [...batch.filter((frame) => again.has(frame.file)), ...queue.slice(256)];
  }
  console.log(JSON.stringify({ pass, frames: files.length, requests, totalMs: Math.round(performance.now() - started), perRequestMs: times,
    recordings, missing, deferred, chunkMB: +(chunkBytes / 1e6).toFixed(1) }));
}
