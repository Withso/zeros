// DeviceHub, agent automation and captures with the real macOS tools behind
// them: Xcode's for iOS simulators, the Android SDK's for Android devices.
// Electron main supplies the image encoders, its own executable, Downloads
// and where snapshots, frames and recordings go.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  SimulatorRecordingEnd,
  SimulatorRecordingsSnapshot,
} from "@zeros/protocol/simulator-captures";
import type { SimulatorFrame, SimulatorHubSnapshot } from "@zeros/protocol/simulators";

import {
  AgentDeviceSessions,
  agentDeviceCliPath,
  agentDeviceEnvironment,
  agentDeviceFolders,
  spawnAgentDevice,
} from "./agent-device";
import { AndroidDeviceFrames } from "./android-device-frame";
import { AndroidDevices, type SpawnEmulator } from "./android-devices";
import { failedRecorder, recordAndroidVideo } from "./android-recorder";
import { AndroidSetup, androidLocations, findAndroidStudio } from "./android-sdk";
import { AxeInput, axeBinaryPath, spawnAxeFrameStream } from "./axe";
import { DeviceHub } from "./device-hub";
import {
  agentDeviceOrientation,
  agentDevicePinch,
  type DeviceScreenPort,
} from "./device-use-controller";
import { inspectIosAppBundle } from "./ios-app-bundle";
import { DeviceFrames } from "./ios-device-frame";
import { readIosDeviceProfile } from "./ios-device-profile";
import { bundleIdForProcess, readIosFrontApp } from "./ios-front-app";
import { downloadIosRuntime, probeIosSetup, readAvailableMemory } from "./ios-setup";
import { IosSimctl } from "./ios-simctl";
import { LiveViews, type EncodeFrame } from "./live-view";
import { fileOwnershipStore } from "./ownership-store";
import { RecordingTimelines } from "./recording-timelines";
import { screenReader, type ScaleScreen } from "./screen-images";
import { SimulatorCaptures } from "./simulator-captures";
import {
  HidInput,
  SIMULATOR_HID_BINARY,
  SimulatorHid,
  simulatorHidOrientation,
} from "./simulator-hid";
import { recordSimulatorVideo } from "./simulator-recorder";
import { XCRUN, runTool } from "./tool-runner";
import { readScreenElements } from "./ui-elements";

export interface SimulatorRuntimeOptions {
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  /** Private app data; simulator state lives in its `simulators` folder. */
  dataDir: string;
  /** Electron's own executable, which runs agent-device as Node. */
  execPath: string;
  env: NodeJS.ProcessEnv;
  encodeJpeg: EncodeFrame;
  scaleScreen: ScaleScreen;
  /** A small PNG data URL of a screenshot file. */
  thumbnail(png: string): Promise<string | null>;
  downloadsDir(): string;
  onSnapshot(snapshot: SimulatorHubSnapshot): void;
  onFrame(frame: SimulatorFrame): void;
  onRecordings(snapshot: SimulatorRecordingsSnapshot): void;
  onRecordingEnd(end: SimulatorRecordingEnd): void;
  log(message: string): void;
}

export interface SimulatorRuntime {
  readonly hub: DeviceHub;
  /** Agent touch, text and app actions, or null in builds without
   * agent-device. */
  readonly automation: AgentDeviceSessions | null;
  readonly captures: SimulatorCaptures;
  /** Agents' screenshots without agent-device. */
  readonly screen: DeviceScreenPort;
  inspectAppBundle(bundlePath: string): Promise<string | null>;
  /** Android Studio, as the last device read found it, or null. */
  androidStudio(): string | null;
  /** On quit: saves recordings, shuts down what Zeros booted and stops
   * agent-device. */
  dispose(): Promise<void>;
}

/** How long quit waits for agent-device, as DeviceHub waits for shutdowns. */
const QUIT_STOP_MS = 8_000;
/** How long an Android shutdown waits for its agent-device session to end. */
const SESSION_CLOSE_MS = 5_000;
const READ_TIMEOUT_MS = 15_000;

function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Its own process group, so the emulator outlives Zeros and a quit's signals
 * never reach it; its output goes to `logFile`. */
const spawnEmulator: SpawnEmulator = (file, args, env, logFile) => {
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const output = openSync(logFile, "w", 0o600);
  try {
    const child = spawn(file, [...args], { env, detached: true, stdio: ["ignore", output, output] });
    child.unref();
    return child;
  } finally {
    closeSync(output);
  }
};

export function createSimulatorRuntime(options: SimulatorRuntimeOptions): SimulatorRuntime {
  const home = path.join(options.dataDir, "simulators");
  const androidPlaces = androidLocations(options.env, os.homedir());
  const android =
    options.platform === "darwin"
      ? new AndroidDevices({
          locations: androidPlaces,
          setup: new AndroidSetup({ locations: androidPlaces, run: runTool }),
          frames: new AndroidDeviceFrames({
            artRoot: async () => (await findAndroidStudio(androidPlaces))?.deviceArt ?? null,
            log: options.log,
          }),
          run: runTool,
          spawn: spawnEmulator,
          logDir: path.join(home, "android-logs"),
          env: options.env,
          log: options.log,
        })
      : null;
  const axe = () =>
    axeBinaryPath({
      packaged: options.packaged,
      resourcesPath: options.resourcesPath,
      repoRoot: options.repoRoot,
      exists: existsSync,
    });
  const hid = new SimulatorHid({
    binary: () =>
      axeBinaryPath({
        packaged: options.packaged,
        resourcesPath: options.resourcesPath,
        repoRoot: options.repoRoot,
        exists: existsSync,
        name: SIMULATOR_HID_BINARY,
      }),
    log: options.log,
  });
  const frames = new DeviceFrames({
    run: runTool,
    cacheRoot: path.join(home, "frames"),
    log: options.log,
  });
  const cli =
    options.platform === "darwin"
      ? agentDeviceCliPath({
          packaged: options.packaged,
          resourcesPath: options.resourcesPath,
          repoRoot: options.repoRoot,
          exists: existsSync,
        })
      : null;
  const folders = agentDeviceFolders(path.join(home, "agent-device"));
  const automation = cli
    ? new AgentDeviceSessions({
        exec: spawnAgentDevice({
          execPath: options.execPath,
          cliPath: () => (existsSync(cli) ? cli : null),
          env: () => agentDeviceEnvironment(options.env, folders, android?.sdkRoot() ?? null),
          cwd: folders.work,
          log: options.log,
        }),
        target: (deviceId) => {
          if (hub.platformOf(deviceId) !== "android") return { platform: "ios", udid: deviceId };
          const serial = android?.serial(deviceId) ?? null;
          return serial ? { platform: "android", serial } : null;
        },
        frontApp: (udid) => readIosFrontApp(runTool, axe(), udid),
        workDir: folders.work,
        log: options.log,
      })
    : null;
  const simctl = new IosSimctl(runTool);
  // Made once the hub it reads devices from exists.
  let captures: SimulatorCaptures | null = null;
  const views = new LiveViews({
    spawn: spawnAxeFrameStream(axe),
    encode: options.encodeJpeg,
    onFrame: options.onFrame,
    log: options.log,
  });
  const hub = new DeviceHub({
    platform: options.platform,
    simctl,
    probeSetup: () => probeIosSetup(runTool),
    readProfile: (bundlePath) => readIosDeviceProfile(runTool, bundlePath),
    readFrame: (chromeIdentifier, screen) => frames.frame(chromeIdentifier, screen),
    input: new HidInput(hid, new AxeInput(axe, runTool)),
    orientation: simulatorHidOrientation(hid, automation ? agentDeviceOrientation(automation) : null),
    ...(automation ? { pinch: agentDevicePinch(automation) } : {}),
    ...(android ? { android } : {}),
    views,
    ownership: fileOwnershipStore(path.join(home, "booted-devices.json")),
    availableMemory: () => readAvailableMemory(runTool),
    downloadRuntime: (onProgress) =>
      downloadIosRuntime(
        (file, args) => spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] }),
        onProgress,
      ),
    beforeShutdown: async (deviceId) => {
      await Promise.all([
        captures?.deviceStopping(deviceId),
        // Ending the session gives the device back its own keyboard, which
        // it would otherwise boot without.
        automation && hub.platformOf(deviceId) === "android"
          ? within(automation.close(deviceId), SESSION_CLOSE_MS)
          : undefined,
      ]);
    },
    onSnapshot: (snapshot) => {
      // A simulator that stopped took its XCTest runner with it; an
      // emulator's serial may go to the next one that starts.
      automation?.keepOnly(
        new Set(
          snapshot.devices.filter((device) => device.state === "booted").map((device) => device.id),
        ),
      );
      captures?.syncDevices(snapshot);
      options.onSnapshot(snapshot);
    },
    log: options.log,
  });
  const recorder = (file: string, args: readonly string[]) =>
    spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  const androidDevice = (deviceId: string) =>
    hub.platformOf(deviceId) === "android" ? android : null;
  const screen: DeviceScreenPort = {
    image: screenReader({
      frame: (deviceId) => views.current(deviceId),
      capture: (deviceId, file) => (androidDevice(deviceId) ?? simctl).screenshot(deviceId, file),
      scale: options.scaleScreen,
      workDir: path.join(home, "screens"),
    }),
    stillFor: (deviceId) => views.stillFor(deviceId),
  };
  const saved = new SimulatorCaptures({
    devices: {
      running: (deviceId) => hub.runningDevice(deviceId),
      screen: (deviceId) => hub.deviceScreen(deviceId),
      hold: (deviceId) => hub.hold(deviceId),
    },
    screenshot: (deviceId, file) =>
      (androidDevice(deviceId) ?? simctl).screenshot(deviceId, file),
    record: (deviceId, file) => {
      const target = androidDevice(deviceId);
      if (!target) return recordSimulatorVideo(recorder, deviceId, file, options.log);
      try {
        return recordAndroidVideo(
          recorder,
          runTool,
          target.recordingTarget(deviceId),
          file,
          options.log,
        );
      } catch (error) {
        return failedRecorder(error instanceof Error ? error.message : String(error));
      }
    },
    describe: async (deviceId) => {
      const target = androidDevice(deviceId);
      if (target) return target.describe(deviceId);
      const binary = axe();
      if (!binary) return null;
      const ui = await runTool(binary, ["describe-ui", "--udid", deviceId], {
        timeoutMs: READ_TIMEOUT_MS,
      });
      return readScreenElements(ui.stdout);
    },
    // Android screens name their app's package themselves.
    appId: async (deviceId, pid) => {
      if (androidDevice(deviceId)) return null;
      const jobs = await runTool(XCRUN, ["simctl", "spawn", deviceId, "launchctl", "list"], {
        timeoutMs: READ_TIMEOUT_MS,
      });
      return bundleIdForProcess(jobs.stdout, pid);
    },
    thumbnail: options.thumbnail,
    downloadsDir: options.downloadsDir,
    workDir: path.join(home, "captures"),
    timelines: new RecordingTimelines(path.join(home, "recordings")),
    onRecordings: options.onRecordings,
    onRecordingEnd: options.onRecordingEnd,
    log: options.log,
  });
  captures = saved;
  return {
    hub,
    automation,
    captures: saved,
    screen,
    inspectAppBundle: (bundlePath) => inspectIosAppBundle(runTool, bundlePath),
    androidStudio: () => android?.studioApp() ?? null,
    async dispose() {
      const stopped = automation ? within(automation.stop(), QUIT_STOP_MS) : Promise.resolve();
      // agent-device gives Android devices their own keyboard back as it
      // stops, so emulators Zeros shuts down wait for it. Recordings finish
      // before the devices they record shut down.
      const androidStops = hub
        .snapshot()
        .devices.some(
          (device) =>
            device.platform === "android" && device.bootedByZeros && device.state !== "shutdown",
        );
      const devicesDown = Promise.all([
        saved.dispose().catch(() => undefined),
        androidStops ? stopped : undefined,
      ]).then(() => hub.dispose());
      await Promise.allSettled([devicesDown, stopped]);
      hid.dispose();
    },
  };
}
