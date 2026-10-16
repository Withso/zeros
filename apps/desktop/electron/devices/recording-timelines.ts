// Recording timelines in Zeros' private data, one file per recording, named
// by the video's fingerprint. A recording dropped into a chat days later
// still finds its timeline; renaming or moving the video doesn't matter.

import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isRecordingFingerprint,
  readSimulatorRecordingTimeline,
  recordingFingerprintHeader,
  recordingFingerprintRanges,
  type SimulatorRecordingTimeline,
} from "@zeros/protocol/simulator-captures";

/** The fingerprint the composer computes for the same file. */
export async function recordingFingerprint(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const hash = createHash("sha256");
    hash.update(recordingFingerprintHeader(size));
    for (const [start, end] of recordingFingerprintRanges(size)) {
      const buffer = Buffer.alloc(end - start);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      hash.update(buffer.subarray(0, filled));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Timelines kept; the oldest go first. */
export const MAX_RECORDING_TIMELINES = 200;

export class RecordingTimelines {
  constructor(
    private readonly folder: string,
    private readonly limit = MAX_RECORDING_TIMELINES,
  ) {}

  async save(fingerprint: string, timeline: SimulatorRecordingTimeline): Promise<void> {
    if (!isRecordingFingerprint(fingerprint)) throw new Error("Invalid recording fingerprint.");
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    const file = path.join(this.folder, `${fingerprint}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(timeline), { mode: 0o600 });
    await rename(temporary, file);
    await this.prune();
  }

  async load(fingerprint: string): Promise<SimulatorRecordingTimeline | null> {
    if (!isRecordingFingerprint(fingerprint)) return null;
    let text: string;
    try {
      text = await readFile(path.join(this.folder, `${fingerprint}.json`), "utf8");
    } catch {
      return null;
    }
    try {
      return readSimulatorRecordingTimeline(JSON.parse(text));
    } catch {
      return null;
    }
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.folder).catch(() => [] as string[])).filter((name) =>
      isRecordingFingerprint(name.replace(/\.json$/, "")),
    );
    if (names.length <= this.limit) return;
    const dated = await Promise.all(
      names.map(async (name) => {
        const file = path.join(this.folder, name);
        const modified = await stat(file).then(
          (info) => info.mtimeMs,
          () => 0,
        );
        return { file, modified };
      }),
    );
    dated.sort((a, b) => a.modified - b.modified);
    await Promise.all(
      dated.slice(0, dated.length - this.limit).map(({ file }) => rm(file, { force: true })),
    );
  }
}
