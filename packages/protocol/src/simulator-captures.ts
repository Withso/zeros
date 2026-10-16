// Simulator screenshots, recordings and annotations: the contract between
// SimulatorCaptures in Electron main, the Simulator tab, its capture
// thumbnails and the composer.
//
// A capture is a file Zeros saved in Downloads. The renderer only echoes the
// capture ids main gave it, and main never takes a path from the renderer.
// Recording timelines stay in Zeros' private data, found again by the video's
// fingerprint, so a recording dropped into a chat later still gets them.

import {
  isSimulatorDeviceId,
  isSimulatorOrientation,
  type SimulatorOrientation,
} from "./simulators";

export const SIMULATOR_CAPTURE_KINDS = ["screenshot", "recording"] as const;
export type SimulatorCaptureKind = (typeof SIMULATOR_CAPTURE_KINDS)[number];

const CAPTURE_ID = /^capture-\d{1,9}$/;

export function isSimulatorCaptureId(value: unknown): value is string {
  return typeof value === "string" && CAPTURE_ID.test(value);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const MAX_LABEL = 200;
const MAX_FILE_NAME = 255;
const MAX_LIST = 200;
const MAX_COORDINATE = 10_000;

function isLabel(value: unknown, max = MAX_LABEL): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A file name Downloads can hold, never a path. */
function isFileName(value: unknown): value is string {
  return (
    isLabel(value, MAX_FILE_NAME) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith(".")
  );
}

const MAX_FILE_DEVICE_NAME = 80;

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** A capture's name without its extension, the way Simulator names its own,
 * such as "Simulator Screenshot - iPhone 17 - 2025-10-12 at 14.03.22", in
 * local time. The device's name can't make it a path. */
export function simulatorCaptureStem(prefix: string, deviceName: string, at: Date): string {
  const device =
    deviceName
      // eslint-disable-next-line no-control-regex -- file names reject C0 and DEL
      .replace(/[/\\:\u0000-\u001f\u007f]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, MAX_FILE_DEVICE_NAME)
      .trim() || "Simulator";
  const date = `${at.getFullYear()}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}`;
  const time = `${twoDigits(at.getHours())}.${twoDigits(at.getMinutes())}.${twoDigits(at.getSeconds())}`;
  return `${prefix} - ${device} - ${date} at ${time}`;
}

const THUMBNAIL_PREFIX = "data:image/png;base64,";
const MAX_THUMBNAIL_CHARS = 1024 * 1024;

/** A PNG data URL small enough to show as a capture's thumbnail. */
export function isSimulatorCaptureThumbnail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(THUMBNAIL_PREFIX) &&
    value.length > THUMBNAIL_PREFIX.length &&
    value.length <= MAX_THUMBNAIL_CHARS
  );
}

export interface SimulatorCapture {
  /** Main's id for the saved file, for drags and Add to chat. */
  id: string;
  kind: SimulatorCaptureKind;
  deviceId: string;
  deviceName: string;
  /** Its name in Downloads. */
  fileName: string;
  /** A small PNG (data URL) of the capture, or null. */
  thumbnail: string | null;
  /** How long a recording runs. */
  durationMs?: number;
}

export function readSimulatorCapture(value: unknown): SimulatorCapture | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isSimulatorCaptureId(record.id) ||
    (record.kind !== "screenshot" && record.kind !== "recording") ||
    !isSimulatorDeviceId(record.deviceId) ||
    !isLabel(record.deviceName) ||
    !isFileName(record.fileName) ||
    (record.thumbnail !== null && !isSimulatorCaptureThumbnail(record.thumbnail)) ||
    (record.durationMs !== undefined && !isTime(record.durationMs))
  ) {
    return null;
  }
  return {
    id: record.id,
    kind: record.kind,
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    fileName: record.fileName,
    thumbnail: record.thumbnail,
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
  };
}

export const SIMULATOR_CAPTURE_MIME_TYPES = {
  screenshot: "image/png",
  recording: "video/mp4",
} as const satisfies Record<SimulatorCaptureKind, string>;

/** A capture's bytes, for Add to chat. */
export interface SimulatorCaptureFile {
  fileName: string;
  mimeType: (typeof SIMULATOR_CAPTURE_MIME_TYPES)[SimulatorCaptureKind];
  bytes: Uint8Array;
}

export function readSimulatorCaptureFile(value: unknown): SimulatorCaptureFile | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isFileName(record.fileName) ||
    (record.mimeType !== "image/png" && record.mimeType !== "video/mp4") ||
    !(record.bytes instanceof Uint8Array) ||
    record.bytes.byteLength === 0
  ) {
    return null;
  }
  return { fileName: record.fileName, mimeType: record.mimeType, bytes: record.bytes };
}

/** Zeros stops a recording that runs this long, so a forgotten one can't
 * fill the disk or keep its simulator from idling out. */
export const MAX_SIMULATOR_RECORDING_MS = 60 * 60_000;

export interface SimulatorRecording {
  deviceId: string;
  /** Epoch milliseconds of the recording's first frame. */
  startedAt: number;
}

export const SIMULATOR_RECORDINGS_VERSION = 1;

export interface SimulatorRecordingsSnapshot {
  version: typeof SIMULATOR_RECORDINGS_VERSION;
  recordings: SimulatorRecording[];
}

export function readSimulatorRecording(value: unknown): SimulatorRecording | null {
  const recording = plainRecord(value);
  if (!recording || !isSimulatorDeviceId(recording.deviceId) || !isTime(recording.startedAt)) {
    return null;
  }
  return { deviceId: recording.deviceId, startedAt: recording.startedAt };
}

export function readSimulatorRecordings(value: unknown): SimulatorRecordingsSnapshot | null {
  const record = plainRecord(value);
  if (
    !record ||
    record.version !== SIMULATOR_RECORDINGS_VERSION ||
    !Array.isArray(record.recordings) ||
    record.recordings.length > MAX_LIST
  ) {
    return null;
  }
  const recordings: SimulatorRecording[] = [];
  for (const entry of record.recordings) {
    const recording = readSimulatorRecording(entry);
    if (!recording) return null;
    recordings.push(recording);
  }
  return { version: SIMULATOR_RECORDINGS_VERSION, recordings };
}

/** Why a recording ended without the tab's Stop: it reached its limit, its
 * device stopped, the recorder exited on its own or Zeros quit. */
export const SIMULATOR_RECORDING_END_REASONS = ["limit", "device", "exited", "quit"] as const;
export type SimulatorRecordingEndReason = (typeof SIMULATOR_RECORDING_END_REASONS)[number];

/** Main → renderer when a recording ends without the tab's Stop. */
export type SimulatorRecordingEnd =
  | { deviceId: string; reason: SimulatorRecordingEndReason; capture: SimulatorCapture }
  | { deviceId: string; reason: SimulatorRecordingEndReason; error: string };

function isRecordingEndReason(value: unknown): value is SimulatorRecordingEndReason {
  return (SIMULATOR_RECORDING_END_REASONS as readonly unknown[]).includes(value);
}

export function readSimulatorRecordingEnd(value: unknown): SimulatorRecordingEnd | null {
  const record = plainRecord(value);
  if (!record || !isSimulatorDeviceId(record.deviceId) || !isRecordingEndReason(record.reason)) {
    return null;
  }
  const { deviceId, reason } = record;
  if (record.capture !== undefined) {
    const capture = readSimulatorCapture(record.capture);
    return capture && capture.deviceId === deviceId ? { deviceId, reason, capture } : null;
  }
  return isLabel(record.error, 300) ? { deviceId, reason, error: record.error } : null;
}

// ── Recording timelines ───────────────────────────────────

export const MAX_SIMULATOR_RECORDING_ACTIONS = 2_000;

/** One thing the user or an agent did during a recording. */
export interface SimulatorRecordingAction {
  /** Milliseconds from the recording's first frame. */
  atMs: number;
  /** Null for the user, else the agent's name. */
  agent: string | null;
  /** Such as `tap Button "Sign in"`. */
  text: string;
}

export interface SimulatorRecordingTimeline {
  deviceName: string;
  osLabel: string;
  actions: SimulatorRecordingAction[];
}

export function readSimulatorRecordingTimeline(
  value: unknown,
): SimulatorRecordingTimeline | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isLabel(record.deviceName) ||
    !isLabel(record.osLabel) ||
    !Array.isArray(record.actions) ||
    record.actions.length > MAX_SIMULATOR_RECORDING_ACTIONS
  ) {
    return null;
  }
  const actions: SimulatorRecordingAction[] = [];
  for (const entry of record.actions) {
    const action = plainRecord(entry);
    if (
      !action ||
      !isTime(action.atMs) ||
      (action.agent !== null && !isLabel(action.agent, 60)) ||
      !isLabel(action.text, 300)
    ) {
      return null;
    }
    actions.push({ atMs: action.atMs, agent: action.agent, text: action.text });
  }
  return { deviceName: record.deviceName, osLabel: record.osLabel, actions };
}

/** `00:03.2` style clock for a moment in a video: `mm:ss.d`, with hours
 * once a video runs that long. */
export function formatRecordingClock(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const hours = Math.floor(tenths / 36_000);
  const minutes = Math.floor((tenths % 36_000) / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

// ── Recording fingerprints ─────────────────────────────────

/** A recording is found again by its size and the SHA-256 of its first and
 * last 64 KiB: an MP4 keeps its index at one end, so this changes whenever
 * the video does, and reading it is bounded however long the video runs. */
export const RECORDING_FINGERPRINT_CHUNK = 64 * 1024;
export const RECORDING_FINGERPRINT_PREFIX = "zeros-recording\n";

/** The byte ranges, end exclusive, hashed after the prefix and size. */
export function recordingFingerprintRanges(size: number): Array<[number, number]> {
  const headEnd = Math.min(RECORDING_FINGERPRINT_CHUNK, size);
  const tailStart = Math.max(headEnd, size - RECORDING_FINGERPRINT_CHUNK);
  return tailStart < size
    ? [
        [0, headEnd],
        [tailStart, size],
      ]
    : [[0, headEnd]];
}

/** What is hashed before the ranges. */
export function recordingFingerprintHeader(size: number): string {
  return `${RECORDING_FINGERPRINT_PREFIX}${size}\n`;
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

export function isRecordingFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT.test(value);
}

// ── UI elements ────────────────────────────────────────────

export interface SimulatorUiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An element of the app on screen, from the accessibility tree, in points
 * of the screen as it is shown upright. */
export interface SimulatorUiElement {
  /** Such as "Button" or "TextField". */
  type: string;
  label: string | null;
  value: string | null;
  identifier: string | null;
  frame: SimulatorUiRect;
}

export const MAX_SIMULATOR_UI_ELEMENTS = 500;
const MAX_ELEMENT_TEXT = 200;

function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ELEMENT_TEXT
    ? value
    : undefined;
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function readRect(value: unknown): SimulatorUiRect | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isCoordinate(record.x) ||
    !isCoordinate(record.y) ||
    !isCoordinate(record.width) ||
    !isCoordinate(record.height) ||
    record.width <= 0 ||
    record.height <= 0
  ) {
    return null;
  }
  return { x: record.x, y: record.y, width: record.width, height: record.height };
}

function readElement(value: unknown): SimulatorUiElement | null {
  const record = plainRecord(value);
  const frame = readRect(record?.frame);
  if (!record || !frame || !isLabel(record.type, 60)) return null;
  const label = optionalText(record.label);
  const elementValue = optionalText(record.value);
  const identifier = optionalText(record.identifier);
  if (label === undefined || elementValue === undefined || identifier === undefined) return null;
  return { type: record.type, label, value: elementValue, identifier, frame };
}

function contains(rect: SimulatorUiRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

function area(rect: SimulatorUiRect): number {
  return rect.width * rect.height;
}

/** The elements under a point, most specific (smallest) first. */
export function simulatorElementsAt(
  elements: readonly SimulatorUiElement[],
  point: { x: number; y: number },
): SimulatorUiElement[] {
  return elements
    .filter((element) => contains(element.frame, point))
    .sort((a, b) => area(a.frame) - area(b.frame));
}

function quoted(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `"${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}"`;
}

/** How a timeline or marks file names an element: `Button "Sign in"`. */
export function simulatorElementName(element: SimulatorUiElement): string {
  const text = element.label ?? element.value ?? element.identifier;
  return text ? `${element.type} ${quoted(text, 80)}` : element.type;
}

// ── Annotation snapshots ───────────────────────────────────

/** The frozen screen Annotate draws on, with what was on it. */
export interface SimulatorAnnotationSnapshot {
  /** The screen as shown upright, as a PNG. */
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** The same screen in points, which the elements use. */
  width: number;
  height: number;
  orientation: SimulatorOrientation;
  deviceName: string;
  osLabel: string;
  /** The app in front, when Zeros could tell. */
  appName: string | null;
  appId: string | null;
  elements: SimulatorUiElement[];
}

const MAX_PNG_BYTES = 64 * 1024 * 1024;

function isDimension(value: unknown): value is number {
  return isCoordinate(value) && value > 0;
}

export function readSimulatorAnnotationSnapshot(
  value: unknown,
): SimulatorAnnotationSnapshot | null {
  const record = plainRecord(value);
  if (
    !record ||
    !(record.png instanceof Uint8Array) ||
    record.png.byteLength === 0 ||
    record.png.byteLength > MAX_PNG_BYTES ||
    !isDimension(record.widthPx) ||
    !isDimension(record.heightPx) ||
    !isDimension(record.width) ||
    !isDimension(record.height) ||
    !isSimulatorOrientation(record.orientation) ||
    !isLabel(record.deviceName) ||
    !isLabel(record.osLabel) ||
    (record.appName !== null && !isLabel(record.appName)) ||
    (record.appId !== null && !isLabel(record.appId)) ||
    !Array.isArray(record.elements) ||
    record.elements.length > MAX_SIMULATOR_UI_ELEMENTS
  ) {
    return null;
  }
  const elements: SimulatorUiElement[] = [];
  for (const entry of record.elements) {
    const element = readElement(entry);
    if (!element) return null;
    elements.push(element);
  }
  return {
    png: record.png,
    widthPx: record.widthPx,
    heightPx: record.heightPx,
    width: record.width,
    height: record.height,
    orientation: record.orientation,
    deviceName: record.deviceName,
    osLabel: record.osLabel,
    appName: record.appName,
    appId: record.appId,
    elements,
  };
}
