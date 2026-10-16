import {
  simulatorPlatformLabel,
  type SimulatorDevice,
  type SimulatorPlatform,
  type SimulatorSetupStatus,
} from "@zeros/protocol/simulators";

/** Xcode's Mac App Store page. The web address hands off to the App Store. */
export const XCODE_APP_STORE_URL = "https://apps.apple.com/app/xcode/id497799835";

export const ANDROID_STUDIO_URL = "https://developer.android.com/studio";

export type SimulatorSetupAction =
  | { kind: "get-xcode"; label: string }
  | { kind: "install-runtime"; label: string }
  | { kind: "cancel-download"; label: string }
  | { kind: "get-android-studio"; label: string }
  | { kind: "open-android-studio"; label: string }
  | { kind: "create-android-device"; label: string };

export interface SimulatorSetupRow {
  tone: "ready" | "warning" | "pending" | "error";
  message: string;
  detail?: string;
  action: SimulatorSetupAction | null;
  /** Offer "Check again" for a fix the user makes outside Zeros. */
  checkAgain: boolean;
  /** Download percent, or null while the size is unknown. */
  progress?: number | null;
}

const PLATFORM_COPY: Record<SimulatorPlatform, { tools: string; runtime: string; ready: string }> = {
  ios: { tools: "Xcode", runtime: "iOS", ready: "Xcode and Simulator installed" },
  android: { tools: "Android Studio", runtime: "Android", ready: "Android Emulator installed" },
};

const GET_ANDROID_STUDIO = { kind: "get-android-studio", label: "Get Android Studio" } as const;
const OPEN_ANDROID_STUDIO = { kind: "open-android-studio", label: "Open Android Studio" } as const;

/** Android Studio installs the emulator, system images and devices, so
 * setup sends what Zeros can't do itself there. */
function androidSetupRow(
  setup: SimulatorSetupStatus,
  deviceCount: number,
): SimulatorSetupRow | null {
  const studio = setup.studioInstalled === true;
  switch (setup.state) {
    case "tools-missing":
      return studio
        ? {
            tone: "warning",
            message: "The Android Emulator isn't installed",
            detail: "Open Android Studio and finish its setup to add it.",
            action: OPEN_ANDROID_STUDIO,
            checkAgain: true,
          }
        : {
            tone: "warning",
            message: "Android Studio isn't installed",
            detail: "The Android Emulator comes with Android Studio, free from Google.",
            action: GET_ANDROID_STUDIO,
            checkAgain: true,
          };
    case "runtime-missing":
      return {
        tone: "warning",
        message: "No Android system image yet",
        detail: "Add a device in Android Studio's Device Manager to download one.",
        action: studio ? OPEN_ANDROID_STUDIO : GET_ANDROID_STUDIO,
        checkAgain: true,
      };
    case "ready": {
      if (deviceCount > 0) return null;
      const { newDevice } = setup;
      if (newDevice && setup.creating) {
        return { tone: "pending", message: `Creating ${newDevice}…`, action: null, checkAgain: false };
      }
      if (newDevice) {
        return {
          tone: "warning",
          message: "No Android simulators yet",
          detail: studio
            ? `Create a ${newDevice}, or add one in Android Studio's Device Manager.`
            : `Create a ${newDevice}.`,
          action: { kind: "create-android-device", label: "Create device" },
          checkAgain: true,
        };
      }
      return {
        tone: "warning",
        message: "No Android simulators yet",
        detail: "Add one in Android Studio's Device Manager.",
        action: studio ? OPEN_ANDROID_STUDIO : null,
        checkAgain: true,
      };
    }
    default:
      return null;
  }
}

/** One line for where a platform's setup stands, and what fixes it. */
export function simulatorSetupRow(
  setup: SimulatorSetupStatus | null,
  platform: SimulatorPlatform,
  deviceCount: number,
): SimulatorSetupRow {
  const copy = PLATFORM_COPY[platform];
  const checking: SimulatorSetupRow = {
    tone: "pending",
    message: `Checking for ${copy.tools}…`,
    action: null,
    checkAgain: false,
  };
  if (!setup) {
    return platform === "ios"
      ? checking
      : {
          tone: "error",
          message: `${simulatorPlatformLabel(platform)} isn't available in this version of Zeros.`,
          action: null,
          checkAgain: false,
        };
  }
  const android = platform === "android" ? androidSetupRow(setup, deviceCount) : null;
  if (android) return android;
  // Android's missing tools, images and devices returned above, so what's
  // left to fix is Xcode's.
  if (setup.download?.state === "downloading") {
    const { progress } = setup.download;
    return {
      tone: "pending",
      message: `Downloading the ${copy.runtime} runtime…`,
      progress: progress === null ? null : Math.round(progress * 100),
      action: { kind: "cancel-download", label: "Cancel" },
      checkAgain: false,
    };
  }
  switch (setup.state) {
    case "checking":
      return checking;
    case "unsupported":
      return {
        tone: "error",
        message: `${simulatorPlatformLabel(platform)} needs a Mac.`,
        action: null,
        checkAgain: false,
      };
    case "tools-missing":
      return {
        tone: "warning",
        message: `${copy.tools} isn't installed`,
        detail: "Simulators come with Xcode, free from the Mac App Store.",
        action: { kind: "get-xcode", label: "Get Xcode" },
        checkAgain: true,
      };
    case "runtime-missing":
      return setup.download?.state === "failed"
        ? {
            tone: "error",
            message: `The ${copy.runtime} runtime didn't download`,
            detail: "Check your connection, then try again.",
            action: { kind: "install-runtime", label: "Try again" },
            checkAgain: true,
          }
        : {
            tone: "warning",
            message: `The ${copy.runtime} runtime isn't installed`,
            detail: `${setup.toolLabel ?? copy.tools} needs it to run simulators.`,
            action: { kind: "install-runtime", label: `Install ${copy.runtime} runtime` },
            checkAgain: true,
          };
    case "ready":
      if (deviceCount === 0) {
        return {
          tone: "warning",
          message: `No ${copy.runtime} simulators yet`,
          detail: "Add one in Xcode under Window › Devices and Simulators.",
          action: null,
          checkAgain: true,
        };
      }
      return {
        tone: "ready",
        message: copy.ready,
        ...(setup.toolLabel ? { detail: setup.toolLabel } : {}),
        action: null,
        checkAgain: false,
      };
  }
}

/** The device picker's last Android item: another device like the one setup
 * offers to create when there are none. */
export function simulatorNewDeviceItem(
  setup: SimulatorSetupStatus | null,
  platform: SimulatorPlatform,
): { label: string; creating: boolean } | null {
  if (platform !== "android" || setup?.state !== "ready" || !setup.newDevice) return null;
  return setup.creating
    ? { label: `Creating ${setup.newDevice}…`, creating: true }
    : { label: `New ${setup.newDevice}`, creating: false };
}

/** The muted second line under a device's name. */
export function simulatorDeviceStatusLabel(device: SimulatorDevice): string {
  switch (device.state) {
    case "booting":
      return "Starting…";
    case "shutting-down":
      return "Shutting down…";
    default:
      return device.osLabel;
  }
}
