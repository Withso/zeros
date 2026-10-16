import type { SimulatorRecordingTimeline } from "@zeros/protocol/simulator-captures";

import { loadSimulatorRecordingTimeline } from "../../simulators/simulator-api";
import {
  keyFrameFileName,
  pickKeyFrames,
  pictureBrightness,
  sceneSampleTimes,
  videoFingerprint,
  videoTimelineFileName,
  videoTimelineText,
  type KeyFrameMoment,
  type PictureSample,
} from "./video-key-frames";

// Reads a dropped video's key frames with a video element and a canvas, the
// way the composer previews images: no ffmpeg, and nothing leaves the Mac
// until the files are staged like any other attachment.

const OPEN_TIMEOUT_MS = 8_000;
const SEEK_TIMEOUT_MS = 3_000;
/** A send waits for the frames, so a video that seeks slowly gets this long
 * for its samples and this long again for its frames, then keeps what it
 * has. */
const READ_BUDGET_MS = 5_000;
const SAMPLE_EDGE_PX = 32;
const KEY_FRAME_EDGE_PX = 1280;
const KEY_FRAME_QUALITY = 0.85;

/** Resolves true when `event` fires, false on an error, abort or timeout. */
function waitFor(
  video: HTMLVideoElement,
  event: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onFail);
      signal?.removeEventListener("abort", onFail);
      resolve(ok);
    };
    const onEvent = () => finish(true);
    const onFail = () => finish(false);
    const timer = window.setTimeout(onFail, timeoutMs);
    video.addEventListener(event, onEvent);
    video.addEventListener("error", onFail);
    signal?.addEventListener("abort", onFail);
    if (signal?.aborted) onFail();
  });
}

function release(video: HTMLVideoElement, url: string): void {
  video.removeAttribute("src");
  video.load();
  URL.revokeObjectURL(url);
}

class VideoReader {
  private sampler: CanvasRenderingContext2D | null = null;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly url: string,
    private readonly signal: AbortSignal | undefined,
    /** Null when the video doesn't say how long it runs. */
    readonly durationMs: number | null,
  ) {}

  static async open(blob: Blob, signal: AbortSignal | undefined): Promise<VideoReader | null> {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const url = URL.createObjectURL(blob);
    const loaded = waitFor(video, "loadeddata", OPEN_TIMEOUT_MS, signal);
    video.src = url;
    if (!(await loaded) || !video.videoWidth || !video.videoHeight) {
      release(video, url);
      return null;
    }
    // A recording written as it streams, such as a browser's WebM, leaves
    // its length out until something seeks past the end.
    if (!Number.isFinite(video.duration)) {
      const found = waitFor(video, "seeked", SEEK_TIMEOUT_MS, signal);
      video.currentTime = Number.MAX_SAFE_INTEGER;
      await found;
    }
    const seconds = video.duration;
    const reader = new VideoReader(
      video,
      url,
      signal,
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    );
    if (!(await reader.seek(0))) {
      reader.close();
      return null;
    }
    return reader;
  }

  async seek(atMs: number): Promise<boolean> {
    if (this.signal?.aborted) return false;
    const seconds = atMs / 1000;
    if (Math.abs(this.video.currentTime - seconds) < 0.001 && this.video.readyState >= 2) {
      return true;
    }
    const seeked = waitFor(this.video, "seeked", SEEK_TIMEOUT_MS, this.signal);
    this.video.currentTime = seconds;
    return seeked;
  }

  private canvas(edge: number): HTMLCanvasElement {
    const { videoWidth: width, videoHeight: height } = this.video;
    const scale = Math.min(1, edge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    return canvas;
  }

  /** The picture now showing, tiny, as brightness. */
  sample(): Uint8Array | null {
    if (!this.sampler) {
      this.sampler = this.canvas(SAMPLE_EDGE_PX).getContext("2d", { willReadFrequently: true });
    }
    const context = this.sampler;
    if (!context) return null;
    const { width, height } = context.canvas;
    context.drawImage(this.video, 0, 0, width, height);
    return pictureBrightness(context.getImageData(0, 0, width, height).data);
  }

  /** The picture now showing, as a JPEG no longer than KEY_FRAME_EDGE_PX. */
  frame(): Promise<Blob | null> {
    const canvas = this.canvas(KEY_FRAME_EDGE_PX);
    const context = canvas.getContext("2d");
    if (!context) return Promise.resolve(null);
    context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", KEY_FRAME_QUALITY));
  }

  close(): void {
    release(this.video, this.url);
  }
}

/** The Zeros timeline of a recording made on this Mac, or null. */
async function recordingTimeline(video: Blob): Promise<SimulatorRecordingTimeline | null> {
  try {
    return await loadSimulatorRecordingTimeline(await videoFingerprint(video));
  } catch {
    return null;
  }
}

async function readVideoContext(
  name: string,
  video: Blob,
  signal: AbortSignal | undefined,
): Promise<File[]> {
  const timeline = await recordingTimeline(video);
  if (signal?.aborted) return [];
  const reader = await VideoReader.open(video, signal);
  const frames: Array<{ file: File; moment: KeyFrameMoment }> = [];
  const durationMs = reader?.durationMs ?? null;
  if (reader) {
    try {
      const samples: PictureSample[] = [];
      const samplesDue = performance.now() + READ_BUDGET_MS;
      for (const atMs of sceneSampleTimes(durationMs ?? 0)) {
        if (performance.now() > samplesDue || !(await reader.seek(atMs))) break;
        const brightness = reader.sample();
        if (brightness) samples.push({ atMs, brightness });
      }
      const moments = pickKeyFrames({
        durationMs: durationMs ?? 0,
        actionsAtMs: timeline?.actions.map((action) => action.atMs) ?? [],
        samples,
      });
      const framesDue = performance.now() + READ_BUDGET_MS;
      for (const moment of moments) {
        if (performance.now() > framesDue || !(await reader.seek(moment.atMs))) break;
        const jpeg = await reader.frame();
        if (!jpeg) continue;
        frames.push({
          file: new File([jpeg], keyFrameFileName(name, frames.length), { type: "image/jpeg" }),
          moment,
        });
      }
    } finally {
      reader.close();
    }
  }
  if (signal?.aborted || (frames.length === 0 && !timeline)) return [];
  const text = videoTimelineText({
    videoName: name,
    durationMs,
    frames: frames.map(({ file, moment }) => ({ fileName: file.name, moment })),
    timeline,
  });
  return [
    ...frames.map(({ file }) => file),
    new File([text], videoTimelineFileName(name), { type: "text/plain" }),
  ];
}

// One video is read at a time, so dropping several doesn't start a decoder
// for each.
let reading: Promise<unknown> = Promise.resolve();

/** The key frames and timeline text a dropped video adds beside itself;
 * none when Zeros can read neither, or `signal` aborts first. */
export function videoContextFiles(
  video: { name: string; blob: Blob },
  signal?: AbortSignal,
): Promise<File[]> {
  const read = reading.then(() =>
    signal?.aborted ? [] : readVideoContext(video.name, video.blob, signal),
  );
  reading = read.catch(() => undefined);
  return read.catch(() => []);
}
