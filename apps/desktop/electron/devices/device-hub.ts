// ──────────────────────────────────────────────────────────
// DeviceHub: simulators in Electron main
// ──────────────────────────────────────────────────────────
//
// Owns booting and shutdown, which devices Zeros booted, live views, the
// user's input and idle shutdown, for iOS simulators and Android virtual
// devices alike. Simulator tabs call it through IPC; agent tools reach it
// through the agent-control service. Every device id it acts on comes from
// its own latest device list.
// ──────────────────────────────────────────────────────────

import {
  SIMULATOR_HUB_VERSION,
  SIMULATOR_PLATFORMS,
  isSimulatorViewId,
  simulatorIdleShutdownMs,
  type SimulatorAppearance,
  type SimulatorBootOutcome,
  type SimulatorBootWarning,
  type SimulatorDevice,
  type SimulatorDeviceFrame,
  type SimulatorDeviceShape,
  type SimulatorDeviceState,
  type SimulatorHubSnapshot,
  type SimulatorInput,
  type SimulatorOrientation,
  type SimulatorPlatform,
  type SimulatorPreferences,
  type SimulatorScreen,
  type SimulatorSetupStatus,
  type SimulatorTouch,
  type SimulatorViewStart,
} from "@zeros/protocol/simulators";

// Type-only, since android-devices imports DeviceActionError from here.
import type { AndroidDevicesRead } from "./android-devices";
import { IdleShutdownScheduler } from "./idle-shutdown";
import type { IosDeviceProfile } from "./ios-device-profile";
import type { IosSetupProbe, RuntimeDownload } from "./ios-setup";
import type { IosAppearance, IosDeviceRecord } from "./ios-simctl";
import type { StartFrameFeed } from "./live-view";
import { ToolFailure } from "./tool-runner";
import { TouchStream } from "./touch-stream";

export interface IosSimctlPort {
  list(): Promise<IosDeviceRecord[]>;
  boot(udid: string, signal?: AbortSignal): Promise<void>;
  shutdown(udid: string): Promise<void>;
  appearance(udid: string): Promise<IosAppearance | null>;
  setAppearance(udid: string, appearance: IosAppearance): Promise<void>;
}

/** What the touch tool sends to the device's HID: one finger at a time. */
export type SimulatorHidInput = Exclude<SimulatorInput, { kind: "pinch" }>;

export interface DeviceInputPort {
  available(): boolean;
  perform(udid: string, input: SimulatorHidInput): Promise<void>;
  /** Gets ready to send input to the device, in the background. */
  prepare?(udid: string): void;
  /** One step of the user's finger as it moves. Resolves false when it
   * couldn't go out live, so nothing reached the device and the press goes
   * out whole, through `perform`, once it ends. */
  touch?(udid: string, touch: SimulatorTouch): Promise<boolean>;
}

export interface DeviceOrientationPort {
  set(udid: string, orientation: SimulatorOrientation, deviceName: string): Promise<void>;
}

/** Two-finger gestures, which the touch tool can't make. */
export interface DevicePinchPort {
  pinch(udid: string, scale: number, deviceName: string): Promise<void>;
}

/** A device failure already worded for people, which the hub passes on
 * instead of its own message. */
export class DeviceActionError extends Error {
  override name = "DeviceActionError";
}

/** Android virtual devices: listed, started, stopped and driven through
 * their emulators. */
export interface AndroidDevicesPort {
  read(): Promise<AndroidDevicesRead>;
  boot(deviceId: string, signal: AbortSignal): Promise<void>;
  shutdown(deviceId: string): Promise<void>;
  /** Makes the device setup offers; resolves to its id. */
  createDevice(): Promise<string>;
  screen(deviceId: string): Promise<SimulatorScreen | null>;
  frame(deviceId: string, screen: SimulatorScreen): Promise<SimulatorDeviceFrame | null>;
  /** Throws, in words for people, when Zeros can't show the device. */
  feed(deviceId: string): StartFrameFeed;
  /** Whether `input` reaches the running device: not one started outside
   * Zeros. */
  drives(deviceId: string): boolean;
  input(deviceId: string, input: SimulatorInput, screen: SimulatorScreen): Promise<void>;
  /** One step of the user's finger as it moves. */
  touch(deviceId: string, touch: SimulatorTouch): Promise<void>;
  rotate(deviceId: string, orientation: SimulatorOrientation): Promise<void>;
  appearance(deviceId: string): Promise<SimulatorAppearance | null>;
  setAppearance(deviceId: string, appearance: SimulatorAppearance): Promise<void>;
  dispose?(): void;
}

export interface LiveViewsPort {
  /** Frames come from AXe, or from `feed` when the device has its own. */
  open(viewId: string, deviceId: string, screen: SimulatorScreen, feed?: StartFrameFeed): void;
  close(viewId: string): void;
  closeDevice(deviceId: string): string[];
  closeAll(): void;
  viewCount(): number;
  /** The device an open view shows. */
  deviceOf(viewId: string): string | null;
  dispose(): void;
}

/** The devices Zeros booted, kept across launches so idle shutdown still
 * applies to them, and so Zeros never stops a device someone else started. */
export interface DeviceOwnershipStore {
  load(): Promise<string[]>;
  save(deviceIds: string[]): Promise<void>;
}

export interface DeviceHubOptions {
  platform: NodeJS.Platform;
  simctl: IosSimctlPort;
  probeSetup(): Promise<IosSetupProbe>;
  readProfile(deviceTypeBundlePath: string): Promise<IosDeviceProfile | null>;
  /** The device's own frame from Xcode, or null to draw Zeros' frame. */
  readFrame?(
    chromeIdentifier: string,
    screen: SimulatorScreen,
  ): Promise<SimulatorDeviceFrame | null>;
  input: DeviceInputPort;
  /** Absent in builds that can't turn devices. */
  orientation?: DeviceOrientationPort;
  /** Absent in builds that can't pinch. */
  pinch?: DevicePinchPort;
  /** Absent in builds without Android devices. */
  android?: AndroidDevicesPort;
  views: LiveViewsPort;
  ownership: DeviceOwnershipStore;
  /** Bytes macOS could hand a new simulator, or null if unknown. */
  availableMemory(): Promise<number | null>;
  downloadRuntime(onProgress: (progress: number | null) => void): RuntimeDownload;
  /** Before Zeros shuts a device down, such as to save its recording. */
  beforeShutdown?(deviceId: string): Promise<void>;
  onSnapshot(snapshot: SimulatorHubSnapshot): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  log?(message: string): void;
}

/** One simulator needs about 1 to 3 GB. */
export const LOW_MEMORY_BYTES = 3 * 1024 ** 3;
/** Devices started or stopped outside Zeros show up within this while a
 * simulator is on screen. */
export const DEVICE_POLL_MS = 10_000;
/** A device caught starting or stopping outside Zeros is read this often
 * until it settles, even with no simulator on screen: its tab shows the
 * change and would otherwise keep showing it. */
export const SETTLING_POLL_MS = 2_000;
const QUIT_SHUTDOWN_MS = 8_000;
const MAX_READ_ATTEMPTS = 3;

/** For logs only: what a tool said can name local paths. */
function message(error: unknown): string {
  if (error instanceof ToolFailure) {
    const said = error.stderr.replace(/\s+/g, " ").trim().slice(0, 500);
    return said ? `${error.message}: ${said}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

interface PendingBoot {
  controller: AbortController;
  done: Promise<SimulatorBootOutcome>;
}

/** A turn Zeros asked a device for; later turns have higher serials. */
interface DeviceTurn {
  orientation: SimulatorOrientation;
  serial: number;
}

/** A device as the hub keeps it. */
interface DeviceRecord {
  device: Omit<SimulatorDevice, "bootedByZeros">;
  /** iOS: the device type bundle, which holds its screen and frame names. */
  deviceTypeBundlePath: string | null;
}

export class DeviceHub {
  private readonly macOS: boolean;
  private records = new Map<string, DeviceRecord>();
  private readonly owned = new Set<string>();
  private readonly booting = new Map<string, PendingBoot>();
  private readonly shuttingDown = new Set<string>();
  private readonly profiles = new Map<string, Promise<IosDeviceProfile | null>>();
  /** How Zeros last turned each running device. A device starts upright each
   * boot. */
  private readonly orientations = new Map<string, DeviceTurn>();
  /** Each device's newest turn until it finishes. It shows from the moment it
   * starts: the screen turns as soon as the device does, so a frame that
   * waited for the device to finish would turn after the screen had. */
  private readonly turning = new Map<string, DeviceTurn>();
  private turnSerial = 0;
  /** The user's finger on each device's live views. */
  private readonly touches = new Map<string, TouchStream>();
  private setup: SimulatorSetupStatus;
  /** Null in builds without Android devices. */
  private androidSetup: SimulatorSetupStatus | null;
  private creating: Promise<string> | null = null;
  private download: RuntimeDownload | null = null;
  /** Bumped by every boot and shutdown, so a device list read while one
   * finished is read again instead of undoing it. */
  private stateVersion = 0;
  private refreshing: Promise<SimulatorHubSnapshot> | null = null;
  private refreshAgain = false;
  private firstRead: Promise<SimulatorHubSnapshot> | null = null;
  private publishQueued = false;
  private disposed = false;
  private viewSerial = 0;
  private pollTimer: unknown = null;
  private currentPreferences: SimulatorPreferences = {
    agentsEnabled: true,
    idleShutdown: "30m",
    showAgentTouches: true,
  };
  private readonly idle: IdleShutdownScheduler;
  private readonly ownershipLoaded: Promise<void>;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: DeviceHubOptions) {
    this.macOS = options.platform === "darwin";
    this.setup = {
      platform: "ios",
      state: this.macOS ? "checking" : "unsupported",
      toolLabel: null,
      download: null,
    };
    this.androidSetup = options.android
      ? {
          platform: "android",
          state: this.macOS ? "checking" : "unsupported",
          toolLabel: null,
          download: null,
          newDevice: null,
          creating: false,
          studioInstalled: false,
        }
      : null;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.idle = new IdleShutdownScheduler({
      now: options.now ?? Date.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onWarning: () => this.publish(),
      onWarningCleared: () => this.publish(),
      onExpire: (deviceId) => {
        const name = this.records.get(deviceId)?.device.name ?? "a simulator";
        options.log?.(`shutting down idle ${name}`);
        void this.shutdown(deviceId).catch((error: unknown) => {
          options.log?.(`idle shutdown failed: ${message(error)}`);
        });
      },
    });
    this.idle.setLimit(simulatorIdleShutdownMs(this.currentPreferences.idleShutdown));
    this.ownershipLoaded = this.macOS
      ? options.ownership.load().then(
          (ids) => {
            for (const id of ids) this.owned.add(id);
            // Devices Zeros booted before a crash still idle out, even if no
            // Simulator tab opens this time.
            if (this.owned.size > 0 && !this.firstRead && !this.disposed) {
              void this.refresh().catch(() => undefined);
            }
          },
          (error: unknown) => {
            options.log?.(`simulator ownership could not be read: ${message(error)}`);
          },
        )
      : Promise.resolve();
  }

  /** The latest snapshot. The first call also starts reading devices, so
   * Zeros runs no device tools until something asks. */
  state(): SimulatorHubSnapshot {
    if (!this.firstRead && this.macOS && !this.disposed) {
      void this.refresh().catch(() => undefined);
    }
    return this.snapshot();
  }

  preferences(): SimulatorPreferences {
    return { ...this.currentPreferences };
  }

  snapshot(): SimulatorHubSnapshot {
    const devices: SimulatorDevice[] = [...this.records.values()].map(({ device }) => {
      const turn = this.turning.get(device.id) ?? this.orientations.get(device.id);
      const orientation = turn?.orientation === "portrait" ? undefined : turn?.orientation;
      return {
        ...device,
        state: this.booting.has(device.id)
          ? "booting"
          : this.shuttingDown.has(device.id)
            ? "shutting-down"
            : device.state,
        bootedByZeros: this.owned.has(device.id),
        ...(orientation ? { orientation } : {}),
      };
    });
    const setup = [this.setup, ...(this.androidSetup ? [this.androidSetup] : [])];
    return {
      version: SIMULATOR_HUB_VERSION,
      devices,
      setup: setup.map((entry) => ({ ...entry, download: entry.download && { ...entry.download } })),
      idleWarnings: this.idle.warnings(),
    };
  }

  /** Re-reads each platform's setup and devices. Concurrent calls share one
   * read, and a call during a read gets a fresh one after it. */
  refresh(): Promise<SimulatorHubSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot());
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const run = async (): Promise<SimulatorHubSnapshot> => {
      do {
        this.refreshAgain = false;
        await this.readDevices();
      } while (this.refreshAgain && !this.disposed);
      return this.snapshot();
    };
    this.refreshing = run().finally(() => {
      this.refreshing = null;
      this.schedulePoll();
    });
    this.firstRead ??= this.refreshing;
    return this.refreshing;
  }

  setPreferences(preferences: SimulatorPreferences): void {
    this.currentPreferences = { ...preferences };
    this.idle.setLimit(simulatorIdleShutdownMs(preferences.idleShutdown));
    this.publish();
  }

  async bootWarnings(deviceId: string): Promise<SimulatorBootWarning[]> {
    const record = await this.knownDevice(deviceId);
    if (record.device.state === "booted" || this.booting.has(deviceId)) return [];
    const warnings: SimulatorBootWarning[] = [];
    const running = this.snapshot().devices.filter(
      (device) => device.state === "booted" || device.state === "booting",
    ).length;
    if (running >= 2) warnings.push("many-devices");
    const available = await this.options.availableMemory().catch(() => null);
    if (available !== null && available < LOW_MEMORY_BYTES) warnings.push("low-memory");
    return warnings;
  }

  async boot(deviceId: string): Promise<SimulatorBootOutcome> {
    const record = await this.knownDevice(deviceId);
    const pending = this.booting.get(deviceId);
    if (pending) return pending.done;
    if (record.device.state === "booted") return "booted";
    if (this.shuttingDown.has(deviceId)) {
      throw new Error(`${record.device.name} is still shutting down.`);
    }
    const controller = new AbortController();
    const cancelled = async (): Promise<SimulatorBootOutcome> => {
      await this.stopDevice(record).catch(() => undefined);
      this.markState(deviceId, "shutdown");
      return "cancelled";
    };
    const done = (async (): Promise<SimulatorBootOutcome> => {
      try {
        await this.startDevice(record, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return cancelled();
        this.options.log?.(`simulator boot failed: ${message(error)}`);
        if (error instanceof DeviceActionError) throw error;
        throw new Error(`Couldn't start ${record.device.name}.`);
      }
      if (controller.signal.aborted) return cancelled();
      this.owned.add(deviceId);
      this.markState(deviceId, "booted");
      this.idle.track(deviceId);
      await this.saveOwnership();
      return "booted";
    })().finally(() => {
      this.booting.delete(deviceId);
      this.publish();
      void this.refresh().catch(() => undefined);
    });
    this.booting.set(deviceId, { controller, done });
    this.publish();
    this.schedulePoll();
    return done;
  }

  cancelBoot(deviceId: string): boolean {
    const pending = this.booting.get(deviceId);
    if (!pending) return false;
    pending.controller.abort();
    return true;
  }

  async shutdown(deviceId: string): Promise<void> {
    const record = await this.knownDevice(deviceId);
    const pending = this.booting.get(deviceId);
    if (pending) {
      pending.controller.abort();
      await pending.done.catch(() => undefined);
      return;
    }
    if (this.shuttingDown.has(deviceId)) return;
    this.shuttingDown.add(deviceId);
    this.options.views.closeDevice(deviceId);
    this.endTouches(deviceId);
    this.idle.untrack(deviceId);
    this.publish();
    try {
      await this.options.beforeShutdown?.(deviceId).catch((error: unknown) => {
        this.options.log?.(`before simulator shutdown: ${message(error)}`);
      });
      await this.stopDevice(record);
      this.markState(deviceId, "shutdown");
      if (this.owned.delete(deviceId)) await this.saveOwnership();
    } catch (error) {
      this.options.log?.(`simulator shutdown failed: ${message(error)}`);
      throw new Error(`Couldn't shut down ${record.device.name}.`);
    } finally {
      this.shuttingDown.delete(deviceId);
      this.publish();
      void this.refresh().catch(() => undefined);
    }
  }

  async startView(deviceId: string): Promise<SimulatorViewStart> {
    const record = await this.bootedDevice(deviceId);
    if (record.device.platform === "android") return this.startAndroidView(record);
    if (!this.options.input.available()) {
      throw new Error("This build of Zeros can't show simulators.");
    }
    const profile = record.deviceTypeBundlePath
      ? await this.profile(record.deviceTypeBundlePath)
      : null;
    if (!profile) throw new Error(`Zeros can't show ${record.device.name}.`);
    const viewId = `view-${++this.viewSerial}`;
    this.options.views.open(viewId, deviceId, profile.screen);
    this.options.input.prepare?.(deviceId);
    this.schedulePoll();
    return { viewId, screen: profile.screen };
  }

  private async startAndroidView(record: DeviceRecord): Promise<SimulatorViewStart> {
    const { id, name } = record.device;
    const android = this.androidPort();
    const screen = await android.screen(id).catch(() => null);
    if (!screen) throw new Error(`Zeros can't show ${name}.`);
    let feed: StartFrameFeed;
    try {
      feed = android.feed(id);
    } catch (error) {
      if (error instanceof DeviceActionError) throw error;
      this.options.log?.(`android view failed: ${message(error)}`);
      throw new Error(`Zeros can't show ${name}.`);
    }
    const viewId = `view-${++this.viewSerial}`;
    this.options.views.open(viewId, id, screen, feed);
    this.schedulePoll();
    return { viewId, screen };
  }

  stopView(viewId: string): boolean {
    if (!isSimulatorViewId(viewId)) return false;
    const deviceId = this.options.views.deviceOf(viewId);
    // A finger left down would keep the device pressed.
    if (deviceId !== null) void this.touches.get(deviceId)?.release(viewId);
    this.options.views.close(viewId);
    return true;
  }

  /** The window that opened the views closed or reloaded. */
  stopAllViews(): void {
    for (const stream of this.touches.values()) void stream.release();
    this.options.views.closeAll();
  }

  /** One step of the user's finger on a live view, sent as it happens. A
   * lift resolves to what the press did, for recordings; steps for a view
   * that closed, or a device that stopped, end with it. */
  touch(deviceId: string, viewId: string, touch: SimulatorTouch): Promise<SimulatorInput | null> {
    const record = this.records.get(deviceId);
    if (
      this.disposed ||
      !record ||
      record.device.state !== "booted" ||
      this.shuttingDown.has(deviceId)
    ) {
      if (touch.phase !== "down" || this.disposed) return Promise.resolve(null);
      return Promise.reject(
        new Error(
          record ? `${record.device.name} isn't running.` : "That simulator is no longer available.",
        ),
      );
    }
    if (this.options.views.deviceOf(viewId) !== deviceId) return Promise.resolve(null);
    let stream = this.touches.get(deviceId);
    if (!stream) {
      stream = this.touchStream(record);
      this.touches.set(deviceId, stream);
    }
    if (touch.phase !== "move") this.idle.use(deviceId);
    return stream.push(viewId, touch);
  }

  private touchStream(record: DeviceRecord): TouchStream {
    const { id, name, platform } = record.device;
    return new TouchStream({
      send: async (touch) => {
        try {
          if (platform === "android") {
            await this.androidPort().touch(id, touch);
            return true;
          }
          return (await this.options.input.touch?.(id, touch)) ?? false;
        } catch (error) {
          if (error instanceof DeviceActionError) throw error;
          this.options.log?.(`simulator touch failed: ${message(error)}`);
          throw new Error(`That didn't reach ${name}.`);
        }
      },
      perform: (gesture) => this.input(id, gesture),
      now: this.options.now ?? Date.now,
      log: this.options.log,
    });
  }

  /** The device stopped: what was pressed on it ended with it. */
  private endTouches(deviceId: string): void {
    this.touches.get(deviceId)?.drop();
    this.touches.delete(deviceId);
  }

  /** The device's screen and its platform's frame for it (Xcode's or Android
   * Studio's), whatever state it is in, so the tab can draw it before it
   * boots. A null frame means the tab draws its own; null means Zeros can't
   * show the device. */
  async deviceShape(deviceId: string): Promise<SimulatorDeviceShape | null> {
    const record = await this.knownDevice(deviceId);
    if (record.device.platform === "android") {
      const android = this.androidPort();
      const screen = await android.screen(deviceId).catch(() => null);
      if (!screen) return null;
      return { screen, frame: await android.frame(deviceId, screen).catch(() => null) };
    }
    const profile = record.deviceTypeBundlePath
      ? await this.profile(record.deviceTypeBundlePath)
      : null;
    if (!profile) return null;
    const frame =
      profile.chromeIdentifier && this.options.readFrame
        ? await this.options
            .readFrame(profile.chromeIdentifier, profile.screen)
            .catch(() => null)
        : null;
    return { screen: profile.screen, frame };
  }

  async input(deviceId: string, input: SimulatorInput): Promise<void> {
    const record = await this.bootedDevice(deviceId);
    this.idle.use(deviceId);
    if (record.device.platform === "android") {
      await this.androidInput(record, input);
      return;
    }
    if (input.kind === "pinch") {
      await this.pinch(record, input.scale);
      return;
    }
    if (input.kind === "button" && input.button === "back") {
      throw new DeviceActionError("iOS simulators have no Back button.");
    }
    try {
      await this.options.input.perform(deviceId, input);
    } catch (error) {
      if (error instanceof DeviceActionError) throw error;
      this.options.log?.(`simulator input failed: ${message(error)}`);
      throw new Error(`That didn't reach ${record.device.name}.`);
    }
  }

  /** The emulator takes every gesture, pinches included, as touches. */
  private async androidInput(record: DeviceRecord, input: SimulatorInput): Promise<void> {
    const { id, name } = record.device;
    const android = this.androidPort();
    try {
      const screen = await android.screen(id);
      if (!screen) throw new Error("the device has no screen size");
      await android.input(id, input, screen);
    } catch (error) {
      if (error instanceof DeviceActionError) throw error;
      this.options.log?.(`android input failed: ${message(error)}`);
      throw new Error(`That didn't reach ${name}.`);
    }
  }

  private async pinch(record: DeviceRecord, scale: number): Promise<void> {
    const port = this.options.pinch;
    if (!port) throw new Error("This build of Zeros can't pinch simulators.");
    const { id, name } = record.device;
    const release = this.idle.hold(id);
    try {
      await port.pinch(id, scale, name);
    } catch (error) {
      if (error instanceof DeviceActionError) throw error;
      this.options.log?.(`simulator pinch failed: ${message(error)}`);
      throw new Error(`Couldn't pinch ${name}.`);
    } finally {
      release();
    }
  }

  async appearance(deviceId: string): Promise<SimulatorAppearance | null> {
    const record = await this.bootedDevice(deviceId);
    const read =
      record.device.platform === "android"
        ? this.androidPort().appearance(deviceId)
        : this.options.simctl.appearance(deviceId);
    return read.catch(() => null);
  }

  async setAppearance(deviceId: string, appearance: SimulatorAppearance): Promise<void> {
    const record = await this.bootedDevice(deviceId);
    this.idle.use(deviceId);
    try {
      if (record.device.platform === "android") {
        await this.androidPort().setAppearance(deviceId, appearance);
      } else {
        await this.options.simctl.setAppearance(deviceId, appearance);
      }
    } catch (error) {
      this.options.log?.(`simulator appearance failed: ${message(error)}`);
      throw new Error(`Couldn't change ${record.device.name}'s appearance.`);
    }
  }

  async rotate(deviceId: string, orientation: SimulatorOrientation): Promise<void> {
    const record = await this.bootedDevice(deviceId);
    const turn = this.turner(record);
    if (!turn) throw new Error("This build of Zeros can't rotate simulators.");
    this.idle.use(deviceId);
    const release = this.idle.hold(deviceId);
    const request: DeviceTurn = { orientation, serial: ++this.turnSerial };
    this.turning.set(deviceId, request);
    this.publish();
    try {
      await turn(orientation);
      const running =
        this.records.get(deviceId)?.device.state === "booted" && !this.shuttingDown.has(deviceId);
      if (running && request.serial > (this.orientations.get(deviceId)?.serial ?? 0)) {
        this.orientations.set(deviceId, request);
      }
    } catch (error) {
      if (error instanceof DeviceActionError) throw error;
      this.options.log?.(`simulator rotation failed: ${message(error)}`);
      throw new Error(`Couldn't rotate ${record.device.name}.`);
    } finally {
      release();
      if (this.turning.get(deviceId) === request) this.turning.delete(deviceId);
      this.publish();
    }
  }

  /** iOS simulators turn through the gesture tool; Android devices through
   * their emulators. Null when this build can't turn the device. */
  private turner(
    record: DeviceRecord,
  ): ((orientation: SimulatorOrientation) => Promise<void>) | null {
    const { id, name } = record.device;
    if (record.device.platform === "android") {
      const android = this.options.android;
      return android ? (orientation) => android.rotate(id, orientation) : null;
    }
    const port = this.options.orientation;
    return port ? (orientation) => port.set(id, orientation, name) : null;
  }

  /** The device's screen in its natural orientation, as its device type
   * (iOS) or configuration (Android) describes it. */
  async deviceScreen(deviceId: string): Promise<SimulatorScreen | null> {
    const record = await this.knownDevice(deviceId);
    if (record.device.platform === "android") {
      return this.androidPort().screen(deviceId).catch(() => null);
    }
    if (!record.deviceTypeBundlePath) return null;
    return (await this.profile(record.deviceTypeBundlePath))?.screen ?? null;
  }

  /** Whether `input` reaches a running device: through the touch tool on
   * iOS, and on Android through an emulator Zeros started. */
  canDrive(deviceId: string): boolean {
    const record = this.records.get(deviceId);
    if (!record || record.device.state !== "booted" || this.shuttingDown.has(deviceId)) return false;
    if (record.device.platform === "android") return this.options.android?.drives(deviceId) ?? false;
    return this.options.input.available();
  }

  /** Which platform's tools a device in the latest list uses. */
  platformOf(deviceId: string): SimulatorPlatform | null {
    return this.records.get(deviceId)?.device.platform ?? null;
  }

  /** A running device as the snapshot shows it, or why it isn't running. */
  async runningDevice(deviceId: string): Promise<SimulatorDevice> {
    await this.bootedDevice(deviceId);
    const device = this.snapshot().devices.find((entry) => entry.id === deviceId);
    if (!device) throw new Error("That simulator is no longer available.");
    return device;
  }

  /** "Keep running" on the idle-shutdown notice, or an agent action. */
  async keepRunning(deviceId: string): Promise<void> {
    await this.knownDevice(deviceId);
    this.idle.use(deviceId);
  }

  /** Keeps a device from idling out during a recording, an install or an
   * agent action. */
  hold(deviceId: string): () => void {
    return this.idle.hold(deviceId);
  }

  installRuntime(): boolean {
    if (!this.macOS || this.download) return false;
    if (this.setup.state !== "runtime-missing" && this.setup.state !== "ready") {
      return false;
    }
    let lastPublish = 0;
    const now = this.options.now ?? Date.now;
    const download = this.options.downloadRuntime((progress) => {
      if (this.download !== download) return;
      this.setup.download = { state: "downloading", progress };
      if (now() - lastPublish >= 250) {
        lastPublish = now();
        this.publish();
      }
    });
    this.download = download;
    this.setup.download = { state: "downloading", progress: null };
    this.publish();
    void download.done.then(
      () => {
        if (this.download !== download) return;
        this.download = null;
        this.setup.download = null;
        void this.refresh().catch(() => undefined);
      },
      (error: unknown) => {
        if (this.download !== download) return;
        this.download = null;
        this.options.log?.(`iOS runtime download failed: ${message(error)}`);
        this.setup.download = { state: "failed", progress: null };
        this.publish();
      },
    );
    return true;
  }

  cancelRuntimeInstall(): boolean {
    const download = this.download;
    if (!download) return false;
    this.download = null;
    this.setup.download = null;
    download.cancel();
    this.publish();
    return true;
  }

  /** Setup's "Create device": makes the Android device setup offers, and
   * resolves to its id once the device list has it. */
  createAndroidDevice(): Promise<string> {
    const android = this.options.android;
    if (this.disposed) return Promise.reject(new Error("Zeros is quitting."));
    if (!this.macOS || !android || !this.androidSetup) {
      return Promise.reject(new Error("This build of Zeros can't make Android devices."));
    }
    if (this.creating) return this.creating;
    if (this.androidSetup.state !== "ready" || !this.androidSetup.newDevice) {
      return Promise.reject(new Error("Zeros can't make an Android device on this Mac."));
    }
    this.androidSetup = { ...this.androidSetup, creating: true };
    this.publish();
    const creating = android
      .createDevice()
      .then(
        async (deviceId) => {
          await this.refresh().catch(() => undefined);
          return deviceId;
        },
        (error: unknown) => {
          this.options.log?.(`android device creation failed: ${message(error)}`);
          throw new Error("Couldn't create the Android device.");
        },
      )
      .finally(() => {
        this.creating = null;
        if (this.androidSetup) this.androidSetup = { ...this.androidSetup, creating: false };
        this.publish();
      });
    this.creating = creating;
    return creating;
  }

  /** On quit: end views and downloads, and shut down what Zeros booted. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer !== null) this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    this.idle.dispose();
    for (const stream of this.touches.values()) void stream.release();
    this.options.views.dispose();
    this.download?.cancel();
    this.download = null;
    // A stopped boot shuts its half-started device down; waiting for that
    // keeps an Android emulator from outliving Zeros with no window.
    const boots = [...this.booting.values()].map(({ controller, done }) => {
      controller.abort();
      return done;
    });
    // A device that stopped leaves the list, so if the user boots it later it
    // is theirs; one still stopping stays, for the next launch to finish.
    const ownedBefore = this.owned.size;
    const stops: Promise<void>[] = [];
    for (const id of [...this.owned]) {
      const record = this.records.get(id);
      if (!record) continue;
      if (record.device.state === "shutdown") {
        this.owned.delete(id);
        continue;
      }
      stops.push(
        this.stopDevice(record).then(() => {
          this.owned.delete(id);
        }),
      );
    }
    if (stops.length > 0 || boots.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...stops, ...boots]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, QUIT_SHUTDOWN_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    if (this.owned.size !== ownedBefore) await this.saveOwnership();
    this.options.android?.dispose?.();
  }

  private async loaded(): Promise<void> {
    if (!this.firstRead) void this.refresh().catch(() => undefined);
    await this.firstRead?.catch(() => undefined);
  }

  private async knownDevice(deviceId: string): Promise<DeviceRecord> {
    if (this.disposed) throw new Error("Zeros is quitting.");
    await this.loaded();
    const record = this.records.get(deviceId);
    if (!record) throw new Error("That simulator is no longer available.");
    return record;
  }

  private async bootedDevice(deviceId: string): Promise<DeviceRecord> {
    const record = await this.knownDevice(deviceId);
    if (record.device.state !== "booted" || this.shuttingDown.has(deviceId)) {
      throw new Error(`${record.device.name} isn't running.`);
    }
    return record;
  }

  private markState(deviceId: string, state: SimulatorDeviceState): void {
    this.stateVersion += 1;
    if (state !== "booted") {
      this.orientations.delete(deviceId);
      this.turning.delete(deviceId);
    }
    const record = this.records.get(deviceId);
    if (record) {
      this.records.set(deviceId, { ...record, device: { ...record.device, state } });
    }
  }

  private profile(bundlePath: string): Promise<IosDeviceProfile | null> {
    let profile = this.profiles.get(bundlePath);
    if (!profile) {
      profile = this.options.readProfile(bundlePath).catch(() => null);
      this.profiles.set(bundlePath, profile);
      void profile.then((value) => {
        if (!value) this.profiles.delete(bundlePath);
      });
    }
    return profile;
  }

  private async readDevices(): Promise<void> {
    if (!this.macOS) return;
    await this.ownershipLoaded;
    await Promise.all([this.readIosDevices(), this.readAndroidDevices()]);
    await this.reconcile();
    this.publish();
  }

  /** A list that fails to read leaves the last one in place. */
  private async readIosDevices(): Promise<void> {
    const probe = await this.options.probeSetup().catch(
      (): IosSetupProbe => ({ state: "tools-missing", toolLabel: null }),
    );
    this.setup = { ...this.setup, state: probe.state, toolLabel: probe.toolLabel };
    if (probe.state === "tools-missing") {
      this.replaceRecords("ios", []);
      return;
    }
    for (let attempt = 1; ; attempt++) {
      const version = this.stateVersion;
      let records: IosDeviceRecord[];
      try {
        records = await this.options.simctl.list();
      } catch (error) {
        this.options.log?.(`simulator list failed: ${message(error)}`);
        return;
      }
      if (version !== this.stateVersion && attempt < MAX_READ_ATTEMPTS) continue;
      this.replaceRecords(
        "ios",
        records.map(({ device, deviceTypeBundlePath }) => ({ device, deviceTypeBundlePath })),
      );
      return;
    }
  }

  private async readAndroidDevices(): Promise<void> {
    const android = this.options.android;
    if (!android) return;
    for (let attempt = 1; ; attempt++) {
      const version = this.stateVersion;
      let read: AndroidDevicesRead;
      try {
        read = await android.read();
      } catch (error) {
        this.options.log?.(`android device list failed: ${message(error)}`);
        if (this.androidSetup?.state === "checking") {
          this.androidSetup = { ...this.androidSetup, state: "tools-missing" };
        }
        return;
      }
      if (version !== this.stateVersion && attempt < MAX_READ_ATTEMPTS) continue;
      const { state, toolLabel, newDevice, studioInstalled } = read.setup;
      if (this.androidSetup) {
        this.androidSetup = { ...this.androidSetup, state, toolLabel, newDevice, studioInstalled };
      }
      this.replaceRecords(
        "android",
        read.devices.map((device) => ({ device, deviceTypeBundlePath: null })),
      );
      return;
    }
  }

  /** Swaps in one platform's devices, keeping the others; devices list by
   * platform, and a clashing id keeps the device listed first. */
  private replaceRecords(platform: SimulatorPlatform, records: readonly DeviceRecord[]): void {
    const next = new Map<string, DeviceRecord>();
    for (const each of SIMULATOR_PLATFORMS) {
      const entries =
        each === platform
          ? records
          : [...this.records.values()].filter((record) => record.device.platform === each);
      for (const record of entries) {
        if (!next.has(record.device.id)) next.set(record.device.id, record);
      }
    }
    this.records = next;
  }

  private androidPort(): AndroidDevicesPort {
    const android = this.options.android;
    if (!android) throw new Error("This build of Zeros can't run Android devices.");
    return android;
  }

  private startDevice(record: DeviceRecord, signal: AbortSignal): Promise<void> {
    const { id, platform } = record.device;
    return platform === "android"
      ? this.androidPort().boot(id, signal)
      : this.options.simctl.boot(id, signal);
  }

  private stopDevice(record: DeviceRecord): Promise<void> {
    const { id, platform } = record.device;
    return platform === "android"
      ? this.androidPort().shutdown(id)
      : this.options.simctl.shutdown(id);
  }

  private async reconcile(): Promise<void> {
    let ownershipChanged = false;
    for (const id of [...this.owned]) {
      if (this.booting.has(id)) continue;
      const state = this.records.get(id)?.device.state;
      if (state === undefined || state === "shutdown") {
        this.owned.delete(id);
        this.idle.untrack(id);
        ownershipChanged = true;
      }
    }
    for (const { device } of this.records.values()) {
      if (this.booting.has(device.id)) continue;
      const running = device.state === "booted" && !this.shuttingDown.has(device.id);
      if (running && this.owned.has(device.id)) {
        if (!this.idle.isTracked(device.id)) this.idle.track(device.id);
      } else {
        this.idle.untrack(device.id);
      }
      if (device.state !== "booted") {
        this.options.views.closeDevice(device.id);
        this.endTouches(device.id);
      }
    }
    for (const id of [...this.touches.keys()]) {
      if (!this.records.has(id)) this.endTouches(id);
    }
    for (const turns of [this.orientations, this.turning]) {
      for (const id of [...turns.keys()]) {
        if (this.records.get(id)?.device.state !== "booted") turns.delete(id);
      }
    }
    if (ownershipChanged) await this.saveOwnership();
  }

  private schedulePoll(): void {
    if (this.pollTimer !== null || this.disposed) return;
    const settling = [...this.records.values()].some(
      ({ device }) =>
        (device.state === "booting" || device.state === "shutting-down") &&
        !this.booting.has(device.id) &&
        !this.shuttingDown.has(device.id),
    );
    if (!settling && this.options.views.viewCount() === 0 && this.booting.size === 0) return;
    this.pollTimer = this.setTimer(
      () => {
        this.pollTimer = null;
        void this.refresh().catch(() => undefined);
      },
      settling ? SETTLING_POLL_MS : DEVICE_POLL_MS,
    );
  }

  private async saveOwnership(): Promise<void> {
    await this.options.ownership.save([...this.owned]).catch((error: unknown) => {
      this.options.log?.(`simulator ownership could not be saved: ${message(error)}`);
    });
  }

  private publish(): void {
    if (this.publishQueued || this.disposed) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      if (!this.disposed) this.options.onSnapshot(this.snapshot());
    });
  }
}
