import {
  formatRecordingClock,
  recordingFingerprintHeader,
  recordingFingerprintRanges,
  type SimulatorRecordingAction,
  type SimulatorRecordingTimeline,
} from "@zeros/protocol/simulator-captures";

// What a video dropped into the composer adds beside itself: up to eight key
// frames and a text timeline. Free of the DOM, so the picking can be tested
// on its own; video-context-files.ts reads the pictures.

export const MAX_KEY_FRAMES = 8;
/** A frame this long after an action shows what the action did. */
export const AFTER_ACTION_MS = 700;
/** The last frame is read this far before the end, where every decoder has
 * one. */
export const LAST_FRAME_INSET_MS = 50;
/** Key frames closer together than this show the same thing. */
export const MIN_KEY_FRAME_GAP_MS = 400;
/** How much a sampled picture must change, from 0 to 1, to count as a new
 * scene. */
export const MIN_SCENE_CHANGE = 0.04;
/** Scene changes are looked for in at most this many samples, so a long
 * video takes no longer to read than a short one. */
export const MAX_SCENE_SAMPLES = 40;
/** A picture still changing this soon after it started to is one change
 * under way, such as a screen sliding in; the picture it settles on is the
 * one worth a frame. */
export const SCENE_SETTLE_MS = 1200;
const SCENE_SAMPLE_SPACING_MS = 500;
const MAX_NAME_SEGMENT = 60;

export type KeyFrameReason = "first" | "last" | "action" | "change";

export interface KeyFrameMoment {
  atMs: number;
  reason: KeyFrameReason;
  /** For an action's frame, the action's index in the timeline. */
  action?: number;
}

export interface PictureSample {
  atMs: number;
  /** One value per pixel, from pictureBrightness. */
  brightness: ArrayLike<number>;
}

export interface SceneChange {
  /** When the new picture had settled. */
  atMs: number;
  /** How different the settled picture is from the one before the change,
   * from 0, the same, to 1. */
  amount: number;
  /** The index of the sample showing the settled picture. */
  sample: number;
}

const VIDEO_EXTENSION = /\.(mp4|m4v|mov|webm)$/i;

export function isVideoFile(file: { name: string; mimeType: string }): boolean {
  if (file.mimeType.startsWith("video/")) return true;
  const untyped = !file.mimeType || file.mimeType === "application/octet-stream";
  return untyped && VIDEO_EXTENSION.test(file.name);
}

// Whole milliseconds, so the last sample and the last key frame are the same
// moment.
function lastMoment(durationMs: number): number {
  return Math.max(0, Math.floor(durationMs) - LAST_FRAME_INSET_MS);
}

function knownLength(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs > 0;
}

/** When to sample the picture for scene changes: about every half second,
 * from the first frame to the last. */
export function sceneSampleTimes(durationMs: number): number[] {
  if (!knownLength(durationMs)) return [];
  const last = lastMoment(durationMs);
  const count = Math.min(
    MAX_SCENE_SAMPLES,
    Math.max(2, Math.round(last / SCENE_SAMPLE_SPACING_MS) + 1),
  );
  return Array.from({ length: count }, (_, index) => Math.round((last * index) / (count - 1)));
}

/** A picture's brightness, one value per pixel, from its RGBA pixels. */
export function pictureBrightness(rgba: ArrayLike<number>): Uint8Array {
  const brightness = new Uint8Array(Math.floor(rgba.length / 4));
  for (let pixel = 0; pixel < brightness.length; pixel += 1) {
    const at = pixel * 4;
    brightness[pixel] = Math.round(
      (rgba[at]! * 299 + rgba[at + 1]! * 587 + rgba[at + 2]! * 114) / 1000,
    );
  }
  return brightness;
}

/** How different two pictures of the same size are, from 0 to 1. */
export function pictureChange(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += Math.abs(a[index]! - b[index]!);
  return total / (a.length * 255);
}

/** Each time the picture changed between samples, at the sample where the
 * new picture had settled. */
export function sceneChanges(samples: readonly PictureSample[]): SceneChange[] {
  const changes: SceneChange[] = [];
  const changed = (from: number, to: number) =>
    pictureChange(samples[from]!.brightness, samples[to]!.brightness) >= MIN_SCENE_CHANGE;
  let index = 1;
  while (index < samples.length) {
    if (!changed(index - 1, index)) {
      index += 1;
      continue;
    }
    const startedAtMs = samples[index - 1]!.atMs;
    let settled = index;
    while (
      settled + 1 < samples.length &&
      samples[settled + 1]!.atMs - startedAtMs <= SCENE_SETTLE_MS &&
      changed(settled, settled + 1)
    ) {
      settled += 1;
    }
    changes.push({
      atMs: samples[settled]!.atMs,
      amount: pictureChange(samples[index - 1]!.brightness, samples[settled]!.brightness),
      sample: settled,
    });
    index = settled + 1;
  }
  return changes;
}

/** Up to MAX_KEY_FRAMES moments, in order: the first and last frames, the
 * moments right after actions spread across the video, then the biggest
 * scene changes to a picture not already kept. */
export function pickKeyFrames({
  durationMs,
  actionsAtMs,
  samples,
}: {
  durationMs: number;
  actionsAtMs: readonly number[];
  /** The pictures sampled at sceneSampleTimes. */
  samples: readonly PictureSample[];
}): KeyFrameMoment[] {
  const picked: KeyFrameMoment[] = [{ atMs: 0, reason: "first" }];
  if (!knownLength(durationMs)) return picked;
  const last = lastMoment(durationMs);
  const clamp = (atMs: number) => Math.min(last, Math.max(0, atMs));
  const distance = (atMs: number) =>
    Math.min(...picked.map((moment) => Math.abs(moment.atMs - atMs)));
  if (last >= MIN_KEY_FRAME_GAP_MS) picked.push({ atMs: last, reason: "last" });

  // With more actions than room, each next frame is the action furthest from
  // those already picked, so the frames cover the whole video.
  const afterActions: KeyFrameMoment[] = actionsAtMs.map((atMs, action) => ({
    atMs: clamp(atMs + AFTER_ACTION_MS),
    reason: "action",
    action,
  }));
  while (picked.length < MAX_KEY_FRAMES && afterActions.length > 0) {
    let best = 0;
    let bestDistance = -1;
    afterActions.forEach((candidate, index) => {
      const away = distance(candidate.atMs);
      if (away > bestDistance) {
        best = index;
        bestDistance = away;
      }
    });
    if (bestDistance < MIN_KEY_FRAME_GAP_MS) break;
    picked.push(afterActions.splice(best, 1)[0]!);
  }

  // A change back to a picture already kept, such as the screen it started
  // on, adds nothing a frame doesn't show already.
  const kept = picked.flatMap((moment) => {
    const sample = samples.find((candidate) => candidate.atMs === moment.atMs);
    return sample ? [sample.brightness] : [];
  });
  const biggest = sceneChanges(samples)
    .filter((change) => change.amount >= MIN_SCENE_CHANGE)
    .sort((a, b) => b.amount - a.amount || a.atMs - b.atMs);
  for (const change of biggest) {
    if (picked.length >= MAX_KEY_FRAMES) break;
    const atMs = clamp(change.atMs);
    const picture = samples[change.sample]!.brightness;
    if (distance(atMs) < MIN_KEY_FRAME_GAP_MS) continue;
    if (kept.some((other) => pictureChange(other, picture) < MIN_SCENE_CHANGE)) continue;
    picked.push({ atMs, reason: "change" });
    kept.push(picture);
  }
  return picked.sort((a, b) => a.atMs - b.atMs);
}

function nameSegment(videoName: string): string {
  const segment = videoName
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_SEGMENT)
    .replace(/-+$/, "");
  return segment || "video";
}

export function keyFrameFileName(videoName: string, index: number): string {
  return `${nameSegment(videoName)}-frame-${index + 1}.jpg`;
}

export function videoTimelineFileName(videoName: string): string {
  return `${nameSegment(videoName)}-timeline.txt`;
}

function actionText(action: SimulatorRecordingAction): string {
  return action.agent ? `${action.text} (by ${action.agent})` : action.text;
}

function momentText(moment: KeyFrameMoment, timeline: SimulatorRecordingTimeline | null): string {
  switch (moment.reason) {
    case "first":
      return "first frame";
    case "last":
      return "last frame";
    case "change":
      return "the picture changed";
    case "action": {
      const action = moment.action === undefined ? undefined : timeline?.actions[moment.action];
      return action ? `after ${actionText(action)}` : "after an action";
    }
  }
}

/** The text that goes beside a video: its length, its key frames and, for a
 * Zeros recording, what the user and agents did, as `00:03.2 tap Button
 * "Sign in"`. */
export function videoTimelineText({
  videoName,
  durationMs,
  frames,
  timeline,
}: {
  videoName: string;
  /** Null when the video's length couldn't be read. */
  durationMs: number | null;
  frames: ReadonlyArray<{ fileName: string; moment: KeyFrameMoment }>;
  timeline: SimulatorRecordingTimeline | null;
}): string {
  const lines = [`Video: ${videoName}`];
  if (durationMs !== null && knownLength(durationMs)) {
    lines.push(`Length: ${formatRecordingClock(durationMs)}`);
  }
  if (timeline) lines.push(`Recorded in Zeros on ${timeline.deviceName} (${timeline.osLabel})`);
  if (frames.length > 0) {
    lines.push("", "Key frames:");
    for (const { fileName, moment } of frames) {
      lines.push(`${formatRecordingClock(moment.atMs)} ${fileName}: ${momentText(moment, timeline)}`);
    }
  }
  if (timeline) {
    lines.push("", "Actions, by the user unless an agent is named:");
    if (timeline.actions.length === 0) lines.push("none");
    for (const action of timeline.actions) {
      lines.push(`${formatRecordingClock(action.atMs)} ${actionText(action)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The fingerprint Zeros filed the recording's timeline under, read from at
 * most the video's first and last 64 KiB. */
export async function videoFingerprint(video: Blob): Promise<string> {
  const parts: BlobPart[] = [recordingFingerprintHeader(video.size)];
  for (const [start, end] of recordingFingerprintRanges(video.size)) {
    parts.push(video.slice(start, end));
  }
  const digest = await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
