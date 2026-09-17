import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { openOwnedTranscript, ownedTranscriptPath } from "../shared/transcript-file";
import {
  agentTranscriptsRoot, SubagentTranscriptParser,
  type ParsedSubagentTranscript,
} from "./subagent-transcript";

interface TranscriptLocation { home?: string; parentAgentId?: string }
export interface TranscriptOwner extends TranscriptLocation { cwd: string }
export interface ChildTranscriptIdentity { agentId?: string; transcriptPath?: string }
export type TranscriptCaptureIssue = "unavailable" | "truncated";
export type TranscriptCapture = ParsedSubagentTranscript & { captureIssue?: TranscriptCaptureIssue };

// These are capture limits, never limits on the provider's actual work.
export const TRANSCRIPT_LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  lineBytes: 256 * 1024,
  pollBytes: 512 * 1024,
  retainedBytes: 32 * 1024 * 1024,
  totalReadBytes: 128 * 1024 * 1024,
  files: 64,
};

function transcriptId(id: string): string | null {
  try {
    const encoded = encodeURIComponent(id).replace(/%/g, "_");
    return encoded && encoded !== "." && encoded !== ".." && encoded.length <= 200 ? encoded : null;
  } catch { return null; }
}

async function parentDirectory(owner: TranscriptOwner): Promise<string | null> {
  const id = owner.parentAgentId && transcriptId(owner.parentAgentId);
  if (!id) return null;
  const root = agentTranscriptsRoot(owner.cwd, owner);
  const exact = join(root, id);
  try {
    // Never fall through an existing native directory to a legacy namesake.
    await lstat(exact);
    return exact;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? join(root, `agent-${id}`) : null;
  }
}

async function childPath(owner: TranscriptOwner, child: ChildTranscriptIdentity): Promise<string | null> {
  const parent = await parentDirectory(owner);
  if (!parent) return null;
  const folder = join(parent, "subagents");
  const id = child.agentId ? transcriptId(child.agentId) : null;
  if (child.transcriptPath) {
    const path = child.transcriptPath;
    // An exact native pointer still needs the current parent/project owner.
    if (!isAbsolute(path) || !basename(path).endsWith(".jsonl") ||
        basename(path).length <= 6 || basename(path).length > 206) return null;
    if (dirname(resolve(path)) !== folder) {
      const home = owner.home ?? homedir();
      const [canonical, expected] = await Promise.all([
        ownedTranscriptPath(home, path), ownedTranscriptPath(home, folder),
      ]);
      if (dirname(canonical) !== expected) return null;
    }
    if (id && basename(path) !== `${id}.jsonl`) return null;
    return path;
  }
  return id ? join(folder, `${id}.jsonl`) : null;
}

export async function findSubagentTranscriptPath(
  cwd: string, agentId: string, opts?: TranscriptLocation,
): Promise<string | null> {
  try {
    const owner = { cwd, ...opts };
    const path = await childPath(owner, { agentId });
    if (!path) return null;
    const { handle } = await openOwnedTranscript(owner.home ?? homedir(), path);
    await handle.close();
    return path;
  } catch { return null; }
}

interface Checkpoint {
  /** Only the unfinished record is buffered, never the entire growing file. */
  bytes: Buffer;
  position: number;
  head: Buffer;
  tail: Buffer;
  stat?: Stats;
  parser: SubagentTranscriptParser;
  offset: number;
  line: number;
  malformed: boolean;
  oversized: boolean;
  droppingLine: boolean;
}

/** One reader per native run. No directory discovery, synchronous reads, or
 * overlapping polls. Appends parse only new records; replacements reset the
 * parser and reconcile by native identities in the translator. */
export class CursorSubagentTranscriptReader {
  private readonly checkpoints = new Map<string, Checkpoint>();
  private retainedBytes = 0;
  private totalReadBytes = 0;
  private disposed = false;
  private active = false;

  constructor(private readonly owner: TranscriptOwner,
    private readonly limits = TRANSCRIPT_LIMITS) {}

  dispose(): void {
    this.disposed = true;
    this.checkpoints.clear();
    this.retainedBytes = 0;
  }

  async read(child: ChildTranscriptIdentity, final = false): Promise<TranscriptCapture> {
    const empty = (captureIssue?: TranscriptCaptureIssue): TranscriptCapture => ({
      steps: [], finalText: "", timeline: [], ...(captureIssue ? { captureIssue } : {}),
    });
    if (this.disposed) return empty();
    // Translator serializes reads. Reject accidental concurrent consumers
    // without clearing the last confirmed snapshot or opening another file.
    if (this.active) return empty();
    this.active = true;
    let opened: Awaited<ReturnType<typeof openOwnedTranscript>> | undefined;
    try {
      const path = await childPath(this.owner, child);
      if (!path) return empty(final ? "unavailable" : undefined);
      opened = await openOwnedTranscript(this.owner.home ?? homedir(), path);
      if (this.disposed) return empty();
      const { handle, stat } = opened;
      let state = this.checkpoints.get(path);
      if (!state) {
        if (this.checkpoints.size >= this.limits.files) return empty("truncated");
        state = { bytes: Buffer.alloc(0), position: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0),
          parser: new SubagentTranscriptParser(), offset: 0,
          line: 0, malformed: false, oversized: false, droppingLine: false };
        this.checkpoints.set(path, state);
      }
      const previous = state.stat;
      const changed = !previous || previous.dev !== stat.dev || previous.ino !== stat.ino ||
        previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs || previous.ctimeMs !== stat.ctimeMs;
      let restart = final || (changed && (stat.size <= state.position ||
        previous?.dev !== stat.dev || previous?.ino !== stat.ino));
      // Bounded anchors detect growing in-place checkpoint rewrites. A final
      // bounded reread verifies the entire snapshot, including middle edits.
      if (!restart && changed && state.position) {
        for (const [position, expected] of [[0, state.head], [state.position - state.tail.length, state.tail]] as const) {
          const length = expected.length;
          const sample = Buffer.alloc(length);
          const { bytesRead } = await handle.read(sample, 0, length, position);
          this.totalReadBytes += bytesRead;
          if (!sample.subarray(0, bytesRead).equals(expected)) restart = true;
        }
      }
      if (restart) {
        this.retainedBytes -= state.position;
        state.bytes = Buffer.alloc(0);
        state.position = 0; state.head = Buffer.alloc(0); state.tail = Buffer.alloc(0);
        state.parser = new SubagentTranscriptParser();
        state.offset = 0; state.line = 0; state.malformed = false;
        state.oversized = false; state.droppingLine = false;
      }
      state.stat = stat;
      const capacity = Math.max(0, Math.min(
        stat.size - state.position,
        this.limits.fileBytes - state.position,
        this.limits.retainedBytes - this.retainedBytes,
        this.limits.totalReadBytes - this.totalReadBytes,
        final ? this.limits.fileBytes : this.limits.pollBytes,
      ));
      // Fixed-size async reads yield between chunks even for final snapshots.
      const chunks: Buffer[] = [];
      let read = 0;
      while (read < capacity && !this.disposed) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, capacity - read));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.position + read);
        if (!bytesRead) break;
        chunks.push(buffer.subarray(0, bytesRead)); read += bytesRead;
      }
      if (this.disposed) return empty();
      this.totalReadBytes += read;
      this.retainedBytes += read;
      if (read) {
        const appended = Buffer.concat(chunks);
        if (state.head.length < 256) state.head = Buffer.concat([state.head, appended.subarray(0, 256 - state.head.length)]);
        // Copy these small anchors so they do not retain a large backing buffer.
        state.tail = Buffer.from(Buffer.concat([state.tail, appended]).subarray(-256));
        state.bytes = Buffer.concat([state.bytes, appended]);
        state.position += read;
      }
      const bytes = state.bytes;
      // No parsing work for unchanged files (including a previously parsed,
      // valid JSON record without a trailing newline).
      if (read || restart) {
        while (state.offset < bytes.length) {
          const newline = bytes.indexOf(10, state.offset);
          const end = newline < 0 ? bytes.length : newline;
          const oversized = state.droppingLine || end - state.offset > this.limits.lineBytes;
          if (oversized) state.oversized = true;
          else {
            const valid = state.parser.push(bytes.subarray(state.offset, end).toString("utf8"), state.line);
            // An unfinished final record is normal during live writes. Keep it
            // buffered and retry it after append, including split UTF-8 bytes.
            if (!valid && (newline >= 0 || final)) state.malformed = true;
          }
          if (newline < 0) {
            if (oversized) { state.droppingLine = true; state.offset = bytes.length; }
            break;
          }
          state.offset = newline + 1; state.line++; state.droppingLine = false;
          if (state.line % 64 === 0) {
            await yieldEventLoop();
            if (this.disposed) return empty();
          }
        }
        state.bytes = Buffer.from(bytes.subarray(state.offset));
        state.offset = 0;
      }
      const truncated = state.oversized || state.parser.truncated || stat.size > this.limits.fileBytes ||
        (state.position < stat.size && (final || this.retainedBytes >= this.limits.retainedBytes ||
          this.totalReadBytes >= this.limits.totalReadBytes));
      return { ...state.parser.snapshot(true),
        ...(truncated ? { captureIssue: "truncated" as const }
          : final && state.malformed ? { captureIssue: "unavailable" as const } : {}),
      };
    } catch {
      return empty(final ? "unavailable" : undefined);
    } finally {
      await opened?.handle.close().catch(() => {});
      this.active = false;
    }
  }
}

export async function loadSubagentTranscript(
  cwd: string, agentId: string, opts?: TranscriptLocation,
): Promise<ParsedSubagentTranscript | null> {
  const reader = new CursorSubagentTranscriptReader({ cwd, ...opts });
  try {
    const parsed = await reader.read({ agentId }, true);
    return parsed.timeline?.length || parsed.finalText ? parsed : null;
  } finally { reader.dispose(); }
}

export async function loadSubagentTranscriptByPath(
  path: string, owner?: TranscriptOwner,
): Promise<ParsedSubagentTranscript | null> {
  if (!owner) return null;
  const reader = new CursorSubagentTranscriptReader(owner);
  try {
    const parsed = await reader.read({ transcriptPath: path }, true);
    return parsed.timeline?.length || parsed.finalText ? parsed : null;
  } finally { reader.dispose(); }
}
