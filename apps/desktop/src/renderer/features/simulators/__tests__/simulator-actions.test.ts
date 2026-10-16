import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  bootSimulator: vi.fn<(deviceId: string) => Promise<string>>(),
  cancelSimulatorBoot: vi.fn<(deviceId: string) => Promise<void>>(),
  shutDownSimulator: vi.fn<(deviceId: string) => Promise<void>>(),
  simulatorBootWarnings: vi.fn<(deviceId: string) => Promise<string[]>>(),
  installSimulatorRuntime: vi.fn<() => Promise<boolean>>(),
  cancelSimulatorRuntimeInstall: vi.fn<() => Promise<void>>(),
  refreshSimulatorHub: vi.fn<() => Promise<unknown>>(),
  createAndroidDevice: vi.fn<() => Promise<string>>(),
  openAndroidStudio: vi.fn<() => Promise<boolean>>(),
}));
const toasts = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
const app = vi.hoisted(() => ({ shellOpenUrl: vi.fn<(url: string) => Promise<void>>() }));
const hub = vi.hoisted(() => ({
  devices: [] as Array<{ id: string; name: string }>,
  loadSimulatorHub: vi.fn<() => Promise<void>>(),
}));

vi.mock("../simulator-api", () => api);
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: toasts }));
vi.mock("../../../platform/app", () => app);
vi.mock("../simulator-hub-store", () => ({
  loadSimulatorHub: hub.loadSimulatorHub,
  simulatorHubState: () => ({ snapshot: { devices: hub.devices }, error: null, loading: false }),
  simulatorDevice: (snapshot: { devices: typeof hub.devices } | null, id: string | undefined) =>
    snapshot?.devices.find((device) => device.id === id) ?? null,
}));

import {
  bootSimulatorFromTab,
  checkSimulatorsAgain,
  createAndroidDeviceFromPicker,
  runSimulatorSetupAction,
  shutDownSimulatorFromTab,
} from "../simulator-actions";
import { ANDROID_STUDIO_URL, XCODE_APP_STORE_URL } from "../simulator-setup-model";

const PHONE = { id: "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108", name: "iPhone 17" };

beforeEach(() => {
  for (const mock of [...Object.values(api), ...Object.values(toasts), app.shellOpenUrl]) {
    mock.mockReset();
  }
  api.bootSimulator.mockResolvedValue("booted");
  api.shutDownSimulator.mockResolvedValue(undefined);
  api.simulatorBootWarnings.mockResolvedValue([]);
  api.installSimulatorRuntime.mockResolvedValue(true);
  api.cancelSimulatorRuntimeInstall.mockResolvedValue(undefined);
  api.refreshSimulatorHub.mockResolvedValue({});
  api.createAndroidDevice.mockResolvedValue("Pixel_10_API_37");
  api.openAndroidStudio.mockResolvedValue(true);
  app.shellOpenUrl.mockResolvedValue(undefined);
  hub.loadSimulatorHub.mockReset();
  hub.loadSimulatorHub.mockResolvedValue(undefined);
  hub.devices = [];
});

describe("simulator tab actions", () => {
  it("warns before a boot that may strain the Mac, then boots anyway", async () => {
    api.simulatorBootWarnings.mockResolvedValue(["many-devices"]);
    await bootSimulatorFromTab(PHONE);
    expect(toasts.warning).toHaveBeenCalledWith("Several simulators are running", {
      id: `simulator-boot-warning:${PHONE.id}`,
      description: "Each one uses about 1 to 3 GB of memory. Shut down any you aren't using.",
    });
    expect(api.bootSimulator).toHaveBeenCalledWith(PHONE.id);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("boots quietly when nothing needs saying, even if the check itself fails", async () => {
    api.simulatorBootWarnings.mockRejectedValue(new Error("vm_stat"));
    await bootSimulatorFromTab(PHONE);
    expect(toasts.warning).not.toHaveBeenCalled();
    expect(api.bootSimulator).toHaveBeenCalledWith(PHONE.id);
  });

  it("shows DeviceHub's own words when a boot or shutdown fails", async () => {
    api.bootSimulator.mockRejectedValue(new Error("iPhone 17 is still shutting down."));
    await bootSimulatorFromTab(PHONE);
    expect(toasts.error).toHaveBeenCalledWith("iPhone 17 is still shutting down.", {
      id: `simulator-boot:${PHONE.id}`,
    });

    api.shutDownSimulator.mockRejectedValue("not an error");
    await shutDownSimulatorFromTab(PHONE);
    expect(toasts.error).toHaveBeenLastCalledWith("Couldn't shut down iPhone 17.", {
      id: `simulator-shutdown:${PHONE.id}`,
    });
  });
});

describe("simulator setup actions", () => {
  it("opens Xcode's App Store page", async () => {
    await runSimulatorSetupAction({ kind: "get-xcode", label: "Get Xcode" });
    expect(app.shellOpenUrl).toHaveBeenCalledWith(XCODE_APP_STORE_URL);
    expect(XCODE_APP_STORE_URL).toMatch(/^https:\/\/apps\.apple\.com\//);
  });

  it("starts and cancels the runtime download, saying when it can't start", async () => {
    await runSimulatorSetupAction({ kind: "install-runtime", label: "Install iOS runtime" });
    expect(api.installSimulatorRuntime).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();

    api.installSimulatorRuntime.mockResolvedValue(false);
    await runSimulatorSetupAction({ kind: "install-runtime", label: "Try again" });
    expect(toasts.error).toHaveBeenLastCalledWith(
      "Zeros couldn't start the iOS runtime download.",
      { id: "simulator-setup" },
    );

    api.installSimulatorRuntime.mockRejectedValue(new Error("xcodebuild isn't responding."));
    await runSimulatorSetupAction({ kind: "install-runtime", label: "Try again" });
    expect(toasts.error).toHaveBeenLastCalledWith("xcodebuild isn't responding.", {
      id: "simulator-setup",
    });

    await runSimulatorSetupAction({ kind: "cancel-download", label: "Cancel" });
    expect(api.cancelSimulatorRuntimeInstall).toHaveBeenCalledTimes(1);
  });

  it("opens Android Studio, or its download page when it isn't installed", async () => {
    await runSimulatorSetupAction({ kind: "get-android-studio", label: "Get Android Studio" });
    expect(app.shellOpenUrl).toHaveBeenCalledWith(ANDROID_STUDIO_URL);
    expect(ANDROID_STUDIO_URL).toMatch(/^https:\/\/developer\.android\.com\//);

    await runSimulatorSetupAction({ kind: "open-android-studio", label: "Open Android Studio" });
    expect(api.openAndroidStudio).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();

    api.openAndroidStudio.mockResolvedValue(false);
    await runSimulatorSetupAction({ kind: "open-android-studio", label: "Open Android Studio" });
    expect(toasts.error).toHaveBeenLastCalledWith("Zeros couldn't open Android Studio.", {
      id: "simulator-setup",
    });
  });

  it("creates an Android device, with DeviceHub's words when that fails", async () => {
    await runSimulatorSetupAction({ kind: "create-android-device", label: "Create device" });
    expect(api.createAndroidDevice).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();

    api.createAndroidDevice.mockRejectedValue(new Error("Couldn't create the Android device."));
    await runSimulatorSetupAction({ kind: "create-android-device", label: "Create device" });
    expect(toasts.error).toHaveBeenLastCalledWith("Couldn't create the Android device.", {
      id: "simulator-setup",
    });
  });

  it("makes another Android device from the picker and hands back the listed device", async () => {
    const created = { id: "Pixel_10_API_37", name: "Pixel 10 (2)" };
    api.createAndroidDevice.mockImplementation(async () => {
      hub.devices = [created];
      return created.id;
    });
    await expect(createAndroidDeviceFromPicker()).resolves.toEqual(created);
    expect(hub.loadSimulatorHub).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();

    api.createAndroidDevice.mockRejectedValue(new Error("Couldn't create the Android device."));
    await expect(createAndroidDeviceFromPicker()).resolves.toBeNull();
    expect(toasts.error).toHaveBeenLastCalledWith("Couldn't create the Android device.", {
      id: "simulator-setup",
    });
  });

  it("checks Xcode and the devices again, quietly unless that fails", async () => {
    await checkSimulatorsAgain();
    expect(api.refreshSimulatorHub).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();

    api.refreshSimulatorHub.mockRejectedValue("offline");
    await checkSimulatorsAgain();
    expect(toasts.error).toHaveBeenCalledWith("Zeros couldn't check for simulators.", {
      id: "simulator-setup",
    });
  });
});
