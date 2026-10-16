import type { SimulatorDevice } from "@zeros/protocol/simulators";

import { shellOpenUrl } from "../../platform/app";
import { toast } from "../../shared/ui/primitives/elements";
import {
  bootSimulator,
  cancelSimulatorBoot,
  cancelSimulatorRuntimeInstall,
  createAndroidDevice,
  installSimulatorRuntime,
  openAndroidStudio,
  refreshSimulatorHub,
  shutDownSimulator,
  simulatorBootWarnings,
} from "./simulator-api";
import { loadSimulatorHub, simulatorDevice, simulatorHubState } from "./simulator-hub-store";
import { simulatorBootWarningNotice, simulatorErrorMessage } from "./simulator-notices";
import {
  ANDROID_STUDIO_URL,
  XCODE_APP_STORE_URL,
  type SimulatorSetupAction,
} from "./simulator-setup-model";

// What the tab's buttons and picker do. Outcomes are toasts, as for every
// other action in the app.

type Device = Pick<SimulatorDevice, "id" | "name">;

/** Boots a device the user chose, first warning when the Mac is short on
 * memory or already running several. */
export async function bootSimulatorFromTab(device: Device): Promise<void> {
  const warnings = await simulatorBootWarnings(device.id).catch(() => []);
  const notice = simulatorBootWarningNotice(device, warnings);
  if (notice) {
    toast.warning(notice.title, {
      id: `simulator-boot-warning:${device.id}`,
      description: notice.description,
    });
  }
  try {
    await bootSimulator(device.id);
  } catch (error) {
    toast.error(simulatorErrorMessage(error, `Couldn't start ${device.name}.`), {
      id: `simulator-boot:${device.id}`,
    });
  }
}

export function cancelSimulatorBootFromTab(device: Device): void {
  void cancelSimulatorBoot(device.id).catch(() => undefined);
}

export async function shutDownSimulatorFromTab(device: Device): Promise<void> {
  try {
    await shutDownSimulator(device.id);
  } catch (error) {
    toast.error(simulatorErrorMessage(error, `Couldn't shut down ${device.name}.`), {
      id: `simulator-shutdown:${device.id}`,
    });
  }
}

const SETUP_TOAST = { id: "simulator-setup" };

/** The setup row's button: get Xcode or Android Studio, start or stop the
 * runtime download, or create an Android device. Progress arrives with the
 * hub's snapshots. */
export async function runSimulatorSetupAction(action: SimulatorSetupAction): Promise<void> {
  try {
    switch (action.kind) {
      case "get-xcode":
        await shellOpenUrl(XCODE_APP_STORE_URL);
        return;
      case "install-runtime":
        if (!(await installSimulatorRuntime())) {
          toast.error("Zeros couldn't start the iOS runtime download.", SETUP_TOAST);
        }
        return;
      case "cancel-download":
        await cancelSimulatorRuntimeInstall();
        return;
      case "get-android-studio":
        await shellOpenUrl(ANDROID_STUDIO_URL);
        return;
      case "open-android-studio":
        if (!(await openAndroidStudio())) {
          toast.error("Zeros couldn't open Android Studio.", SETUP_TOAST);
        }
        return;
      case "create-android-device":
        await createAndroidDevice();
        return;
    }
  } catch (error) {
    toast.error(simulatorErrorMessage(error, "Zeros couldn't change the simulator setup."), SETUP_TOAST);
  }
}

/** The device picker's "New …": makes the device and returns it as the hub
 * lists it, or null after saying why it couldn't. */
export async function createAndroidDeviceFromPicker(): Promise<SimulatorDevice | null> {
  try {
    const deviceId = await createAndroidDevice();
    await loadSimulatorHub();
    return simulatorDevice(simulatorHubState().snapshot, deviceId);
  } catch (error) {
    toast.error(simulatorErrorMessage(error, "Couldn't create the Android device."), SETUP_TOAST);
    return null;
  }
}

/** "Check again" after installing Xcode, a runtime or a device outside Zeros.
 * The hub publishes what it finds. */
export async function checkSimulatorsAgain(): Promise<void> {
  try {
    await refreshSimulatorHub();
  } catch (error) {
    toast.error(simulatorErrorMessage(error, "Zeros couldn't check for simulators."), SETUP_TOAST);
  }
}
