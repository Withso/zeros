// ──────────────────────────────────────────────────────────
// SimulatorCaptures: screenshots, recordings and annotation snapshots
// ──────────────────────────────────────────────────────────
//
// Saves screenshots and recordings to Downloads under the names Simulator
// gives them and remembers which file each capture id names, so the tab can
// drag one out or add it to a chat. The renderer only echoes capture ids;
// no path ever comes from it.
//
// A recording holds its device off idle shutdown and logs what the user and
// agents do while it runs. It ends on Stop, its time limit, the device
// stopping or quit; its timeline goes to private data under the video's
// fingerprint.
// ──────────────────────────────────────────────────────────

import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { MAX_ATTACHMENT_BYTES } from "@zeros/protocol/attachment-policy";
import {
  MAX_SIMULATOR_RECORDING_MS,
  SIMULATOR_CAPTURE_MIME_TYPES,
  SIMULATOR_RECORDINGS_VERSION,
  isRecordingFingerprint,
  isSimulatorCaptureId,
  isSimulatorCaptureThumbnail,
  type SimulatorAnnotationSnapshot,
  type SimulatorCapture,
  type SimulatorCaptureFile,
  type SimulatorCaptureKind,
  type SimulatorRecording,
  type SimulatorRecordingEnd,
  type SimulatorRecordingEndReason,
  type SimulatorRecordingTimeline,
  type SimulatorRecordingsSnapshot,
  type SimulatorUiElement,
} from "@zeros/protocol/simulator-captures";
import type {
  SimulatorDevice,
  SimulatorHubSnapshot,
  SimulatorOrientation,
  SimulatorScreen,
} from "@zeros/protocol/simulators";

import { uprightPoint, type DeviceSpace } from "./agent-device-output";
import { captureFileName, freeFileName } from "./capture-names";
import { RecordingLog, type RecordedAction } from "./recording-timeline";
import { recordingFingerprint } from "./recording-timelines";
import type { RecorderProcess } from "./simulator-recorder";
import { SECURE_TEXT_FIELD, type ScreenElements } from "./ui-elements";

export interface CaptureDevicesPort {
  /** A running device, or the hub's own words for why it isn't. */
  running(deviceId: string): Promise<SimulatorDevice>;
  screen(deviceId: string): Promise<SimulatorScreen | null>;
  hold(deviceId: string): () => void;
}

export interface TimelineStorePort {
  save(fingerprint: string, timeline: SimulatorRecordingTimeline): Promise<void>;
  load(fingerprint: string): Promise<SimulatorRecordingTimeline | null>;
}

export interface SimulatorCapturesOptions {
  devices: CaptureDevicesPort;
  screenshot(udid: string, file: string): Promise<void>;
  record(udid: string, file: string): RecorderProcess;
  /** What is on the screen, or null when the device's tools can't tell. */
  describe(udid: string): Promise<ScreenElements | null>;
  /** The app ID of a process on the device, for a screen that names only
   * the process. */
  appId(udid: string, pid: number): Promise<string | null>;
  /** A small PNG data URL of a screenshot file. */
  thumbnail(png: string): Promise<string | null>;
  /** Where captures are saved: the user's Downloads. */
  downloadsDir(): string;
  /** Private folder for captures in progress. */
  workDir: string;
  timelines: TimelineStorePort;
  onRecordings(snapshot: SimulatorRecordingsSnapshot): void;
  /** A recording ended without the tab's Stop. */
  onRecordingEnd(end: SimulatorRecordingEnd): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  log?(message: string): void;
}

/** A saved capture's file, for a drag or Finder. */
export interface SavedCapture {
  capture: SimulatorCapture;
  path: string;
}

/** How long a stopped recording may take to finish its file. */
export const RECORDING_FINISH_MS = 20_000;
/** After an action, the screen settles this long before Zeros reads it. */
export const SCREEN_SETTLE_MS = 800;
/** While recording, the screen is read again this often without actions. */
export const SCREEN_POLL_MS = 5_000;
const QUIT_FINISH_MS = 8_000;
const MAX_CAPTURES = 100;

const CANT_SAVE =
  "Zeros can't save to Downloads. Allow it in System Settings > Privacy & Security > Files & Folders.";

interface ScreenRead {
  elements: ScreenElements;
  /** The action count when it was read; later actions make it stale. */
  actions: number;
  orientation: SimulatorOrientation;
}

interface ActiveRecording {
  deviceId: string;
  deviceName: string;
  osLabel: string;
  startedAt: number;
  file: string;
  /** A screenshot of the first frame, for the thumbnail. */
  poster: string;
  posterTaken: Promise<boolean>;
  process: RecorderProcess;
  release: () => void;
  log: RecordingLog;
  orientation: SimulatorOrientation;
  actions: number;
  screen: ScreenRead | null;
  reading: boolean;
  readAgain: boolean;
  screenTimer: unknown;
  limitTimer: unknown;
  ending: Promise<SimulatorCapture> | null;
}

type EndReason = "stop" | SimulatorRecordingEndReason;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function goneFromDownloads(saved: SavedCapture): Error {
  return new Error(
    saved.capture.kind === "screenshot"
      ? "That screenshot isn't in Downloads anymore."
      : "That recording isn't in Downloads anymore.",
  );
}

/** Width and height from a PNG's header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function landscape(space: DeviceSpace): boolean {
  return space.width > space.height;
}

/**
 * The elements in the screenshot's points. A screenshot shows the screen as
 * the device is turned; an app that stayed portrait while the device turned
 * (the iPhone Home Screen) still names its elements in portrait points.
 */
export function placeElements(
  elements: ScreenElements,
  shot: DeviceSpace,
  orientation: SimulatorOrientation,
): SimulatorUiElement[] {
  const { space } = elements;
  if (!space || landscape(space) === landscape(shot)) {
    if (!space) return elements.elements;
    const sx = shot.width / space.width;
    const sy = shot.height / space.height;
    if (Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return elements.elements;
    return elements.elements.map((element) => ({
      ...element,
      frame: {
        x: element.frame.x * sx,
        y: element.frame.y * sy,
        width: element.frame.width * sx,
        height: element.frame.height * sy,
      },
    }));
  }
  return elements.elements.map((element) => {
    const { x, y, width, height } = element.frame;
    const corners = [
      uprightPoint({ x, y }, shot, orientation),
      uprightPoint({ x: x + width, y: y + height }, shot, orientation),
    ];
    const left = Math.min(corners[0]!.x, corners[1]!.x);
    const top = Math.min(corners[0]!.y, corners[1]!.y);
    return {
      ...element,
      frame: {
        x: left,
        y: top,
        width: Math.max(corners[0]!.x, corners[1]!.x) - left,
        height: Math.max(corners[0]!.y, corners[1]!.y) - top,
      },
    };
  });
}

export class SimulatorCaptures {
  private readonly saved = new Map<string, SavedCapture>();
  private readonly active = new Map<string, ActiveRecording>();
  private readonly starting = new Map<string, Promise<SimulatorRecording>>();
  private serial = 0;
  private fileSerial = 0;
  private disposed = false;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: SimulatorCapturesOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  // ── Screenshots ──────────────────────────────────────────

  async screenshot(deviceId: string): Promise<SimulatorCapture> {
    this.ensureOpen();
    const device = await this.options.devices.running(deviceId);
    const takenAt = this.now();
    const release = this.options.devices.hold(deviceId);
    const file = await this.workFile(".png");
    try {
      try {
        await this.options.screenshot(deviceId, file);
      } catch (error) {
        this.options.log?.(`simulator screenshot failed: ${message(error)}`);
        throw new Error(`Couldn't take a screenshot of ${device.name}.`);
      }
      const saved = await this.saveToDownloads(
        file,
        captureFileName("screenshot", device.name, new Date(takenAt)),
      );
      return await this.remember("screenshot", device, saved, file);
    } finally {
      release();
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  // ── Recordings ───────────────────────────────────────────

  recordings(): SimulatorRecordingsSnapshot {
    return {
      version: SIMULATOR_RECORDINGS_VERSION,
      recordings: [...this.active.values()]
        .filter((recording) => !recording.ending)
        .map(({ deviceId, startedAt }) => ({ deviceId, startedAt })),
    };
  }

  startRecording(deviceId: string): Promise<SimulatorRecording> {
    const pending = this.starting.get(deviceId);
    if (pending) return pending;
    const start = this.begin(deviceId).finally(() => {
      this.starting.delete(deviceId);
    });
    this.starting.set(deviceId, start);
    return start;
  }

  async stopRecording(deviceId: string): Promise<SimulatorCapture> {
    await this.starting.get(deviceId)?.catch(() => undefined);
    const recording = this.active.get(deviceId);
    if (!recording) throw new Error("That simulator isn't recording.");
    return this.end(recording, "stop");
  }

  /** What the user or an agent did on a device; logged while it records. */
  noteAction(deviceId: string, agent: string | null, action: RecordedAction): void {
    const recording = this.active.get(deviceId);
    if (!recording || recording.ending) return;
    const screen = recording.screen;
    const fresh =
      screen &&
      screen.actions === recording.actions &&
      screen.orientation === recording.orientation;
    // A screen read a moment ago still shows whether a password field is up;
    // with no read at all, nobody can tell.
    const maskTyping =
      !screen || screen.elements.elements.some((element) => element.type === SECURE_TEXT_FIELD);
    recording.log.note(this.now(), agent, action, {
      orientation: recording.orientation,
      screen: fresh ? { space: screen.elements.space, elements: screen.elements.elements } : null,
      maskTyping,
    });
    recording.actions += 1;
    this.readScreenSoon(recording, SCREEN_SETTLE_MS);
  }

  /** DeviceHub's latest devices: a turned device's screen reads again, and
   * a stopped one ends its recording. */
  syncDevices(snapshot: SimulatorHubSnapshot): void {
    for (const recording of this.active.values()) {
      if (recording.ending) continue;
      const device = snapshot.devices.find((entry) => entry.id === recording.deviceId);
      if (!device || device.state !== "booted") {
        void this.endWithNotice(recording, "device");
        continue;
      }
      const orientation = device.orientation ?? "portrait";
      if (orientation !== recording.orientation) {
        recording.orientation = orientation;
        recording.actions += 1;
        this.readScreenSoon(recording, SCREEN_SETTLE_MS);
      }
    }
  }

  /** Before DeviceHub shuts a device down: its recording is saved first. */
  async deviceStopping(deviceId: string): Promise<void> {
    await this.starting.get(deviceId)?.catch(() => undefined);
    const recording = this.active.get(deviceId);
    if (recording) await this.endWithNotice(recording, "device");
  }

  async timeline(fingerprint: string): Promise<SimulatorRecordingTimeline | null> {
    if (!isRecordingFingerprint(fingerprint)) return null;
    return this.options.timelines.load(fingerprint).catch(() => null);
  }

  // ── Saved captures ───────────────────────────────────────

  /** The saved file for a drag or Finder, if it is still where Zeros put it. */
  async savedFile(captureId: string): Promise<SavedCapture> {
    const saved = this.knownCapture(captureId);
    const info = await lstat(saved.path).catch(() => null);
    if (!info?.isFile()) throw goneFromDownloads(saved);
    return saved;
  }

  /** A capture's bytes, for Add to chat. */
  async file(captureId: string): Promise<SimulatorCaptureFile> {
    const saved = this.knownCapture(captureId);
    // Check and read through one descriptor so nothing can be swapped in
    // between; a link or a pipe put in the capture's place is refused.
    const handle = await open(
      saved.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => null);
    if (!handle) throw goneFromDownloads(saved);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw goneFromDownloads(saved);
      if (info.size > MAX_ATTACHMENT_BYTES) {
        throw new Error("That recording is too large to add to a chat. It's in Downloads.");
      }
      const bytes = await handle.readFile();
      return {
        fileName: saved.capture.fileName,
        mimeType: SIMULATOR_CAPTURE_MIME_TYPES[saved.capture.kind],
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      };
    } finally {
      await handle.close();
    }
  }

  // ── Annotation ───────────────────────────────────────────

  /** The screen as it is now, frozen for Annotate, with what is on it. */
  async annotationSnapshot(deviceId: string): Promise<SimulatorAnnotationSnapshot> {
    this.ensureOpen();
    const device = await this.options.devices.running(deviceId);
    const orientation = device.orientation ?? "portrait";
    const file = await this.workFile(".png");
    try {
      const [png, elements, screen] = await Promise.all([
        this.options
          .screenshot(deviceId, file)
          .then(() => readFile(file))
          .catch((error: unknown) => {
            this.options.log?.(`simulator annotation screenshot failed: ${message(error)}`);
            throw new Error(`Couldn't capture ${device.name}'s screen.`);
          }),
        this.options.describe(deviceId).catch(() => null),
        this.options.devices.screen(deviceId).catch(() => null),
      ]);
      const size = pngSize(png);
      if (!size) throw new Error(`Couldn't capture ${device.name}'s screen.`);
      const space = elements?.space;
      const scale =
        screen?.scale ??
        (space
          ? Math.max(size.width, size.height) / Math.max(space.width, space.height)
          : 1);
      const shot = { width: size.width / scale, height: size.height / scale };
      const appId =
        elements?.appId ??
        (elements?.pid === null || elements?.pid === undefined
          ? null
          : await this.options.appId(deviceId, elements.pid).catch(() => null));
      return {
        png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength),
        widthPx: size.width,
        heightPx: size.height,
        width: shot.width,
        height: shot.height,
        orientation,
        deviceName: device.name,
        osLabel: device.osLabel,
        appName: elements?.appName ?? null,
        appId,
        elements: elements ? placeElements(elements, shot, orientation) : [],
      };
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  /** On quit: every recording is saved, within a bound. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const ending = [...this.active.values()].map((recording) =>
      this.endWithNotice(recording, "quit"),
    );
    if (ending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(ending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUIT_FINISH_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  // ── Internals ────────────────────────────────────────────

  private ensureOpen(): void {
    if (this.disposed) throw new Error("Zeros is quitting.");
  }

  private knownCapture(captureId: string): SavedCapture {
    const saved = isSimulatorCaptureId(captureId) ? this.saved.get(captureId) : undefined;
    if (!saved) throw new Error("That capture is no longer available.");
    return saved;
  }

  private async workFile(extension: string): Promise<string> {
    await mkdir(this.options.workDir, { recursive: true, mode: 0o700 });
    return this.workPath(extension);
  }

  /** A new file name in the work folder, once it exists. */
  private workPath(extension: string): string {
    return path.join(this.options.workDir, `capture-${process.pid}-${++this.fileSerial}${extension}`);
  }

  private async begin(deviceId: string): Promise<SimulatorRecording> {
    this.ensureOpen();
    const current = this.active.get(deviceId);
    if (current && !current.ending) {
      return { deviceId, startedAt: current.startedAt };
    }
    await current?.ending?.catch(() => undefined);
    const device = await this.options.devices.running(deviceId);
    const file = await this.workFile(".mp4");
    const release = this.options.devices.hold(deviceId);
    const recorder = this.options.record(deviceId, file);
    try {
      await recorder.started;
      this.ensureOpen();
    } catch (error) {
      recorder.kill();
      release();
      await rm(file, { force: true }).catch(() => undefined);
      if (this.disposed) throw new Error("Zeros is quitting.");
      this.options.log?.(`simulator recording failed to start: ${message(error)}`);
      throw new Error(`Couldn't start recording ${device.name}.`);
    }
    const startedAt = this.now();
    // QuickLook's video thumbnails come back stretched to the size asked for,
    // so a recording's thumbnail is a screenshot of its first frame.
    const poster = this.workPath(".png");
    const posterTaken = this.options.screenshot(deviceId, poster).then(
      () => true,
      () => false,
    );
    const recording: ActiveRecording = {
      deviceId,
      deviceName: device.name,
      osLabel: device.osLabel,
      startedAt,
      file,
      poster,
      posterTaken,
      process: recorder,
      release,
      log: new RecordingLog(startedAt),
      orientation: device.orientation ?? "portrait",
      actions: 0,
      screen: null,
      reading: false,
      readAgain: false,
      screenTimer: null,
      limitTimer: null,
      ending: null,
    };
    this.active.set(deviceId, recording);
    recording.limitTimer = this.setTimer(() => {
      recording.limitTimer = null;
      void this.endWithNotice(recording, "limit");
    }, MAX_SIMULATOR_RECORDING_MS);
    void recorder.exited.then(() => {
      if (!recording.ending) void this.endWithNotice(recording, "exited");
    });
    this.readScreenSoon(recording, 0);
    this.publish();
    return { deviceId, startedAt };
  }

  /** Ends a recording the tab didn't stop, and tells the tab how it went. */
  private async endWithNotice(
    recording: ActiveRecording,
    reason: SimulatorRecordingEndReason,
  ): Promise<void> {
    const first = !recording.ending;
    const { deviceId } = recording;
    try {
      const capture = await this.end(recording, reason);
      if (first) this.options.onRecordingEnd({ deviceId, reason, capture });
    } catch (error) {
      if (first) this.options.onRecordingEnd({ deviceId, reason, error: message(error) });
    }
  }

  private end(recording: ActiveRecording, reason: EndReason): Promise<SimulatorCapture> {
    if (recording.ending) return recording.ending;
    recording.ending = this.finish(recording, reason);
    this.publish();
    return recording.ending;
  }

  private async finish(recording: ActiveRecording, reason: EndReason): Promise<SimulatorCapture> {
    const stoppedAt = this.now();
    if (recording.limitTimer !== null) this.clearTimer(recording.limitTimer);
    if (recording.screenTimer !== null) this.clearTimer(recording.screenTimer);
    recording.limitTimer = null;
    recording.screenTimer = null;
    if (reason !== "exited") recording.process.stop();
    let timer: unknown = null;
    const finished = await Promise.race([
      recording.process.exited,
      new Promise<null>((resolve) => {
        timer = this.setTimer(() => resolve(null), RECORDING_FINISH_MS);
      }),
    ]);
    if (timer !== null) this.clearTimer(timer);
    if (finished === null) recording.process.kill();
    const { deviceId, deviceName } = recording;
    try {
      if (finished !== true) {
        this.options.log?.(`simulator recording did not finish (${reason})`);
        throw new Error(`Couldn't save the recording of ${deviceName}.`);
      }
      const info = await lstat(recording.file).catch(() => null);
      if (!info?.isFile() || info.size === 0) {
        throw new Error(`Couldn't save the recording of ${deviceName}.`);
      }
      const saved = await this.saveToDownloads(
        recording.file,
        captureFileName("recording", deviceName, new Date(recording.startedAt)),
      );
      await this.saveTimeline(recording, saved);
      return await this.remember(
        "recording",
        { id: deviceId, name: deviceName },
        saved,
        (await recording.posterTaken) ? recording.poster : null,
        Math.max(0, stoppedAt - recording.startedAt),
      );
    } finally {
      recording.release();
      await recording.posterTaken;
      await rm(recording.file, { force: true }).catch(() => undefined);
      await rm(recording.poster, { force: true }).catch(() => undefined);
      if (this.active.get(deviceId) === recording) this.active.delete(deviceId);
      this.publish();
    }
  }

  private async saveTimeline(recording: ActiveRecording, file: string): Promise<void> {
    try {
      const fingerprint = await recordingFingerprint(file);
      await this.options.timelines.save(fingerprint, {
        deviceName: recording.deviceName,
        osLabel: recording.osLabel,
        actions: recording.log.actions(),
      });
    } catch (error) {
      this.options.log?.(`simulator recording timeline could not be saved: ${message(error)}`);
    }
  }

  private readScreenSoon(recording: ActiveRecording, delay: number): void {
    if (recording.ending) return;
    if (recording.screenTimer !== null) this.clearTimer(recording.screenTimer);
    recording.screenTimer = this.setTimer(() => {
      recording.screenTimer = null;
      void this.readScreen(recording);
    }, delay);
  }

  private async readScreen(recording: ActiveRecording): Promise<void> {
    if (recording.ending) return;
    if (recording.reading) {
      recording.readAgain = true;
      return;
    }
    recording.reading = true;
    const actions = recording.actions;
    const orientation = recording.orientation;
    try {
      const elements = await this.options.describe(recording.deviceId);
      if (elements && actions === recording.actions && orientation === recording.orientation) {
        recording.screen = { elements, actions, orientation };
      }
    } catch {
      // Timelines name what they can; a missed read leaves points.
    } finally {
      recording.reading = false;
      const again = recording.readAgain;
      recording.readAgain = false;
      this.readScreenSoon(recording, again ? SCREEN_SETTLE_MS : SCREEN_POLL_MS);
    }
  }

  /** Moves a finished file into Downloads under a free name, never over
   * another file. */
  private async saveToDownloads(file: string, name: string): Promise<string> {
    const folder = this.options.downloadsDir();
    try {
      await mkdir(folder, { recursive: true });
    } catch (error) {
      this.options.log?.(`Downloads unavailable: ${message(error)}`);
      throw new Error(CANT_SAVE);
    }
    const taken = new Set<string>();
    for (;;) {
      const candidate = freeFileName(name, (entry) => taken.has(entry));
      if (!candidate) throw new Error("Downloads has too many captures with this name.");
      const target = path.join(folder, candidate);
      const exists = await lstat(target).then(
        () => true,
        () => false,
      );
      if (exists) {
        taken.add(candidate);
        continue;
      }
      try {
        await link(file, target);
        return target;
      } catch (error) {
        if (code(error) === "EEXIST") {
          taken.add(candidate);
          continue;
        }
        if (code(error) !== "EXDEV" && code(error) !== "ENOTSUP" && code(error) !== "EPERM") {
          this.options.log?.(`saving a capture failed: ${message(error)}`);
          throw new Error(CANT_SAVE);
        }
      }
      try {
        await copyFile(file, target, constants.COPYFILE_EXCL);
        return target;
      } catch (error) {
        if (code(error) === "EEXIST") {
          taken.add(candidate);
          continue;
        }
        this.options.log?.(`saving a capture failed: ${message(error)}`);
        throw new Error(CANT_SAVE);
      }
    }
  }

  private async remember(
    kind: SimulatorCaptureKind,
    device: Pick<SimulatorDevice, "id" | "name">,
    file: string,
    /** The PNG its thumbnail is made from. */
    picture: string | null,
    durationMs?: number,
  ): Promise<SimulatorCapture> {
    const thumbnail = picture
      ? await this.options.thumbnail(picture).catch((error: unknown) => {
          this.options.log?.(`capture thumbnail failed: ${message(error)}`);
          return null;
        })
      : null;
    const capture: SimulatorCapture = {
      id: `capture-${++this.serial}`,
      kind,
      deviceId: device.id,
      deviceName: device.name,
      fileName: path.basename(file),
      thumbnail: isSimulatorCaptureThumbnail(thumbnail) ? thumbnail : null,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    this.saved.set(capture.id, { capture, path: file });
    for (const id of this.saved.keys()) {
      if (this.saved.size <= MAX_CAPTURES) break;
      this.saved.delete(id);
    }
    return capture;
  }

  private publish(): void {
    try {
      this.options.onRecordings(this.recordings());
    } catch {
      // The renderer's copy is advisory.
    }
  }
}
