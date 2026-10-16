// Simulator tab commands. The renderer only echoes device, view and capture
// ids it read from main, which checks every id against its own lists; this
// layer checks shapes so nothing malformed reaches the hub. No path ever
// comes from the renderer.

import type { IpcMainInvokeEvent } from "electron";

import {
  DEVICE_TOOLS_SERVICE_VERSION,
  type DeviceUseStateSnapshot,
} from "@zeros/protocol/device-tools";
import { isRecordingFingerprint, isSimulatorCaptureId } from "@zeros/protocol/simulator-captures";
import {
  isSimulatorDeviceId,
  isSimulatorOrientation,
  isSimulatorViewId,
  readSimulatorInput,
  readSimulatorPreferences,
  readSimulatorTouch,
} from "@zeros/protocol/simulators";

import type { DeviceHub } from "../../devices/device-hub";
import type { DeviceUseController } from "../../devices/device-use-controller";
import { recordedInput } from "../../devices/recording-timeline";
import type { SavedCapture, SimulatorCaptures } from "../../devices/simulator-captures";
import type { CommandHandler } from "../router";

export type SimulatorCommandHub = Pick<
  DeviceHub,
  | "state"
  | "refresh"
  | "bootWarnings"
  | "boot"
  | "cancelBoot"
  | "shutdown"
  | "startView"
  | "stopView"
  | "input"
  | "touch"
  | "appearance"
  | "setAppearance"
  | "rotate"
  | "keepRunning"
  | "installRuntime"
  | "cancelRuntimeInstall"
  | "createAndroidDevice"
  | "setPreferences"
  | "deviceShape"
>;

export type SimulatorCommandDeviceUse = Pick<DeviceUseController, "state" | "stopFromUser">;

export type SimulatorCommandCaptures = Pick<
  SimulatorCaptures,
  | "screenshot"
  | "recordings"
  | "startRecording"
  | "stopRecording"
  | "noteAction"
  | "savedFile"
  | "file"
  | "timeline"
  | "annotationSnapshot"
>;

export const SIMULATOR_COMMAND_NAMES = [
  "simulator_hub_state",
  "simulator_hub_refresh",
  "simulator_boot_warnings",
  "simulator_boot",
  "simulator_boot_cancel",
  "simulator_shutdown",
  "simulator_view_start",
  "simulator_view_stop",
  "simulator_input",
  "simulator_touch",
  "simulator_appearance",
  "simulator_appearance_set",
  "simulator_keep_running",
  "simulator_runtime_install",
  "simulator_runtime_install_cancel",
  "simulator_android_device_create",
  "simulator_android_studio_open",
  "simulator_preferences_update",
  "simulator_device_shape",
  "simulator_rotate",
  "simulator_agent_state",
  "simulator_agent_stop",
  "simulator_screenshot",
  "simulator_recording_start",
  "simulator_recording_stop",
  "simulator_recordings",
  "simulator_capture_file",
  "simulator_capture_drag",
  "simulator_recording_timeline",
  "simulator_annotation_snapshot",
] as const;
export type SimulatorCommandName = (typeof SIMULATOR_COMMAND_NAMES)[number];

const NO_AGENTS: DeviceUseStateSnapshot = { version: DEVICE_TOOLS_SERVICE_VERSION, holders: [] };

function deviceId(args: Record<string, unknown>): string {
  if (!isSimulatorDeviceId(args.deviceId)) throw new Error("Invalid simulator request.");
  return args.deviceId;
}

function captureId(args: Record<string, unknown>): string {
  if (!isSimulatorCaptureId(args.captureId)) throw new Error("Invalid simulator capture.");
  return args.captureId;
}

export function simulatorCommands(options: {
  hub: SimulatorCommandHub;
  /** Agents on simulators, or null where agents can't use them. */
  deviceUse: SimulatorCommandDeviceUse | null;
  captures: SimulatorCommandCaptures;
  /** Drags a saved capture out of the page that asked, as a real file. */
  startDrag(event: IpcMainInvokeEvent, saved: SavedCapture): void;
  /** Opens the Android Studio the last device read found; false without
   * one. */
  openAndroidStudio(): Promise<boolean>;
  /** Throws unless the call came from the app window's own page. */
  trust(event: IpcMainInvokeEvent): void;
}): Record<SimulatorCommandName, CommandHandler> {
  const { hub, deviceUse, captures } = options;
  const commands: Record<SimulatorCommandName, CommandHandler> = {
    simulator_hub_state: () => hub.state(),
    simulator_hub_refresh: () => hub.refresh(),
    simulator_boot_warnings: (args) => hub.bootWarnings(deviceId(args)),
    simulator_boot: (args) => hub.boot(deviceId(args)),
    simulator_boot_cancel: (args) => hub.cancelBoot(deviceId(args)),
    simulator_shutdown: async (args) => {
      await hub.shutdown(deviceId(args));
      return true;
    },
    simulator_view_start: (args) => hub.startView(deviceId(args)),
    simulator_view_stop: (args) => {
      if (!isSimulatorViewId(args.viewId)) throw new Error("Invalid simulator request.");
      return hub.stopView(args.viewId);
    },
    simulator_input: async (args) => {
      const id = deviceId(args);
      const input = readSimulatorInput(args.input);
      if (!input) throw new Error("Invalid simulator input.");
      await hub.input(id, input);
      captures.noteAction(id, null, recordedInput(input));
      return true;
    },
    simulator_touch: async (args) => {
      const id = deviceId(args);
      if (!isSimulatorViewId(args.viewId)) throw new Error("Invalid simulator request.");
      const touch = readSimulatorTouch(args.touch);
      if (!touch) throw new Error("Invalid simulator touch.");
      const gesture = await hub.touch(id, args.viewId, touch);
      if (gesture) captures.noteAction(id, null, recordedInput(gesture));
      return true;
    },
    simulator_appearance: (args) => hub.appearance(deviceId(args)),
    simulator_appearance_set: async (args) => {
      const id = deviceId(args);
      if (args.appearance !== "light" && args.appearance !== "dark") {
        throw new Error("Invalid simulator appearance.");
      }
      await hub.setAppearance(id, args.appearance);
      captures.noteAction(id, null, { kind: "appearance", appearance: args.appearance });
      return true;
    },
    simulator_keep_running: async (args) => {
      await hub.keepRunning(deviceId(args));
      return true;
    },
    simulator_runtime_install: () => hub.installRuntime(),
    simulator_runtime_install_cancel: () => hub.cancelRuntimeInstall(),
    simulator_android_device_create: () => hub.createAndroidDevice(),
    simulator_android_studio_open: () => options.openAndroidStudio(),
    simulator_preferences_update: (args) => {
      const preferences = readSimulatorPreferences(args);
      if (!preferences) throw new Error("Invalid simulator preferences.");
      hub.setPreferences(preferences);
      return true;
    },
    simulator_device_shape: (args) => hub.deviceShape(deviceId(args)),
    simulator_rotate: async (args) => {
      const id = deviceId(args);
      if (!isSimulatorOrientation(args.orientation)) {
        throw new Error("Invalid simulator orientation.");
      }
      await hub.rotate(id, args.orientation);
      captures.noteAction(id, null, { kind: "rotate", orientation: args.orientation });
      return true;
    },
    simulator_agent_state: () => deviceUse?.state() ?? NO_AGENTS,
    // The control bar's Stop in a Simulator tab.
    simulator_agent_stop: (args) => deviceUse?.stopFromUser(deviceId(args)) ?? false,
    simulator_screenshot: (args) => captures.screenshot(deviceId(args)),
    simulator_recording_start: (args) => captures.startRecording(deviceId(args)),
    simulator_recording_stop: (args) => captures.stopRecording(deviceId(args)),
    simulator_recordings: () => captures.recordings(),
    simulator_capture_file: (args) => captures.file(captureId(args)),
    simulator_capture_drag: async (args, event) => {
      const saved = await captures.savedFile(captureId(args));
      options.startDrag(event, saved);
      return true;
    },
    simulator_recording_timeline: (args) => {
      if (!isRecordingFingerprint(args.fingerprint)) throw new Error("Invalid recording.");
      return captures.timeline(args.fingerprint);
    },
    simulator_annotation_snapshot: (args) => captures.annotationSnapshot(deviceId(args)),
  };
  for (const name of SIMULATOR_COMMAND_NAMES) {
    const handler = commands[name];
    commands[name] = (args, event) => {
      options.trust(event);
      return handler(args, event);
    };
  }
  return commands;
}
