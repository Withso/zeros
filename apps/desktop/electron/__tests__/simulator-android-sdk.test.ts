import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AndroidSetup,
  androidLocations,
  createAndroidDevice,
  findAndroidSdk,
  findAndroidStudio,
  freeAvdName,
  newestPixelProfile,
  newestStableImage,
  parseIni,
  patchAvdConfig,
  readAvds,
  readRunningEmulators,
  readSystemImages,
  type AndroidLocations,
} from "../devices/android-sdk";
import type { ToolRunner } from "../devices/tool-runner";

let root: string;
let locations: AndroidLocations;

async function file(relative: string, content: string, mode?: number): Promise<string> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  if (mode !== undefined) await chmod(target, mode);
  return target;
}

const sdk = (relative = "") => path.join(root, "sdk", relative);

async function systemImage(
  platform: string,
  tag: string,
  abi: string,
  api: string,
  release: string,
  codename = "REL",
): Promise<void> {
  const dir = `sdk/system-images/${platform}/${tag}/${abi}`;
  await file(`${dir}/source.properties`, `AndroidVersion.ApiLevel=${api}\nSystemImage.TagId=${tag}\n`);
  await file(
    `${dir}/build.prop`,
    `ro.build.version.codename=${codename}\nro.build.version.release_or_codename=${release}\n`,
  );
}

async function avd(id: string, config: Record<string, string>, dirName = `${id}.avd`): Promise<void> {
  const dir = path.join(root, "home", ".android", "avd", dirName);
  await file(
    `home/.android/avd/${id}.ini`,
    `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${dirName}\ntarget=android-37.0\n`,
  );
  await file(
    `home/.android/avd/${dirName}/config.ini`,
    Object.entries(config)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
}

const PHONE_CONFIG = {
  "avd.ini.displayname": "Medium Phone API 37.0",
  "hw.device.name": "medium_phone",
  "hw.lcd.width": "1080",
  "hw.lcd.height": "2400",
  "hw.lcd.density": "420",
  "image.sysdir.1": "system-images/android-37.0/google_apis_playstore/arm64-v8a/",
  "tag.id": "google_apis_playstore",
  "hw.gpu.mode": "auto",
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-android-sdk-"));
  locations = androidLocations({}, path.join(root, "home"));
  locations.sdkRoots = [path.join(root, "missing"), sdk()];
  locations.studioApps = [path.join(root, "Android Studio.app")];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function installTools(): Promise<void> {
  await file("sdk/emulator/emulator", "#!/bin/sh\n", 0o755);
  await file("sdk/emulator/source.properties", "Pkg.Revision=37.2.12\nPkg.Desc=Android Emulator\n");
  await file("sdk/platform-tools/adb", "#!/bin/sh\n", 0o755);
  await file("sdk/cmdline-tools/latest/bin/avdmanager", "#!/bin/sh\n", 0o755);
}

async function installStudio(): Promise<void> {
  await file("Android Studio.app/Contents/jbr/Contents/Home/bin/java", "#!/bin/sh\n", 0o755);
  await mkdir(
    path.join(root, "Android Studio.app/Contents/plugins/android/resources/device-art-resources"),
    { recursive: true },
  );
}

describe("androidLocations", () => {
  it("follows the emulator's own environment variables, ignoring relative ones", () => {
    expect(androidLocations({}, "/Users/me")).toEqual({
      sdkRoots: ["/Users/me/Library/Android/sdk"],
      avdHome: "/Users/me/.android/avd",
      runningDir: "/Users/me/Library/Caches/TemporaryItems/avd/running",
      studioApps: ["/Applications/Android Studio.app", "/Users/me/Applications/Android Studio.app"],
    });
    const custom = androidLocations(
      { ANDROID_HOME: "/sdk", ANDROID_SDK_ROOT: "relative/sdk", ANDROID_USER_HOME: "/state" },
      "/Users/me",
    );
    expect(custom.sdkRoots).toEqual(["/sdk", "/Users/me/Library/Android/sdk"]);
    expect(custom.avdHome).toBe("/state/avd");
    expect(androidLocations({ ANDROID_AVD_HOME: "/avds" }, "/Users/me").avdHome).toBe("/avds");
  });
});

describe("parseIni", () => {
  it("reads key=value lines with spaces, comments and = in values", () => {
    expect([...parseIni("# c\na=1\n b = two \nc=x=y\n\nbad\n").entries()]).toEqual([
      ["a", "1"],
      ["b", "two"],
      ["c", "x=y"],
    ]);
  });
});

describe("findAndroidSdk and findAndroidStudio", () => {
  it("finds the first SDK that exists, its tools and the emulator's version", async () => {
    await installTools();
    expect(await findAndroidSdk(locations)).toEqual({
      root: sdk(),
      emulator: sdk("emulator/emulator"),
      adb: sdk("platform-tools/adb"),
      avdmanager: sdk("cmdline-tools/latest/bin/avdmanager"),
      emulatorVersion: "37.2.12",
    });
  });

  it("falls back to versioned command-line tools and reports missing ones", async () => {
    await file("sdk/cmdline-tools/9.0/bin/avdmanager", "", 0o755);
    await file("sdk/cmdline-tools/12.0/bin/avdmanager", "", 0o755);
    await file("sdk/emulator/emulator", "", 0o644);
    expect(await findAndroidSdk(locations)).toMatchObject({
      emulator: null,
      adb: null,
      avdmanager: sdk("cmdline-tools/12.0/bin/avdmanager"),
      emulatorVersion: null,
    });
    locations.sdkRoots = [path.join(root, "missing")];
    expect(await findAndroidSdk(locations)).toBeNull();
  });

  it("finds Android Studio's Java and device frames", async () => {
    expect(await findAndroidStudio(locations)).toBeNull();
    await installStudio();
    const app = path.join(root, "Android Studio.app");
    expect(await findAndroidStudio(locations)).toEqual({
      app,
      javaHome: path.join(app, "Contents/jbr/Contents/Home"),
      deviceArt: path.join(app, "Contents/plugins/android/resources/device-art-resources"),
    });
  });
});

describe("readAvds", () => {
  it("lists phones and tablets with their screens, newest Android first", async () => {
    await systemImage("android-37.0", "google_apis_playstore", "arm64-v8a", "37.0", "17");
    await systemImage("android-35", "google_apis", "arm64-v8a", "35", "15");
    await avd("Medium_Phone_API_37.0", PHONE_CONFIG, "Medium_Phone.avd");
    await avd("Pixel_Tablet", {
      "avd.ini.displayname": "Pixel Tablet",
      "hw.device.name": "pixel_tablet",
      "hw.lcd.width": "2560",
      "hw.lcd.height": "1600",
      "hw.lcd.density": "320",
      "image.sysdir.1": "system-images/android-37.0/google_apis_playstore/arm64-v8a/",
      "tag.id": "google_apis_playstore",
      "hw.gpu.mode": " SwiftShader_Indirect ",
    });
    await avd("Old_Phone", {
      "hw.lcd.width": "1080",
      "hw.lcd.height": "2400",
      "hw.lcd.density": "420",
      "image.sysdir.1": "system-images/android-35/google_apis/arm64-v8a/",
    });
    await avd("Watch", { ...PHONE_CONFIG, "tag.id": "android-wear" });
    await avd("Escapes", { ...PHONE_CONFIG, "image.sysdir.1": "../../etc/" });
    await file("home/.android/avd/--flag.ini", "path=/tmp\n");

    const avds = await readAvds(sdk(), locations.avdHome);
    expect(avds.map((entry) => entry.id)).toEqual([
      "Medium_Phone_API_37.0",
      "Pixel_Tablet",
      "Old_Phone",
      "Escapes",
    ]);
    expect(avds.find((entry) => entry.id === "Medium_Phone_API_37.0")).toEqual({
      id: "Medium_Phone_API_37.0",
      name: "Medium Phone API 37.0",
      profile: "medium_phone",
      screen: { widthPx: 1080, heightPx: 2400, scale: 2.625 },
      formFactor: "phone",
      osLabel: "Android 17",
      apiLevel: 37,
      gpuMode: "auto",
    });
    expect(avds.find((entry) => entry.id === "Pixel_Tablet")).toMatchObject({
      formFactor: "tablet",
      screen: { widthPx: 2560, heightPx: 1600, scale: 2 },
      gpuMode: "swiftshader_indirect",
    });
    expect(avds.find((entry) => entry.id === "Old_Phone")).toMatchObject({
      name: "Old Phone",
      profile: null,
      osLabel: "Android 15",
      gpuMode: null,
    });
    // An image path outside the SDK is never read.
    expect(avds.find((entry) => entry.id === "Escapes")).toMatchObject({
      osLabel: "Android API 37.0",
      apiLevel: 0,
    });
  });

  it("returns nothing without an AVD folder", async () => {
    expect(await readAvds(null, path.join(root, "nowhere"))).toEqual([]);
  });
});

describe("readRunningEmulators", () => {
  it("reads live emulators' ports and tokens and skips crashed ones", async () => {
    const running = path.join(root, "running");
    await file(
      "running/pid_100.ini",
      [
        "avd.id=Medium_Phone_API_37.0",
        "port.serial=5554",
        "grpc.port=8554",
        "grpc.token=abcdefgh12345678", // gitleaks:allow — synthetic emulator gRPC token
        "cmdline=emulator -avd Medium_Phone_API_37.0 -no-window",
      ].join("\n"),
    );
    await file("running/pid_200.ini", "avd.id=Pixel_10\nport.serial=5556\n");
    await file("running/pid_300.ini", "avd.id=Studio_Device\nport.serial=5558\ngrpc.port=8556\n");
    await file("running/pid_400.ini", "avd.id=--flag\n");
    await file("running/notes.txt", "");
    const alive = (pid: number) => pid !== 200;
    const emulators = await readRunningEmulators(running, alive);
    expect(emulators.sort((a, b) => a.pid - b.pid)).toEqual([
      {
        pid: 100,
        avdId: "Medium_Phone_API_37.0",
        serial: "emulator-5554",
        grpcPort: 8554,
        token: "abcdefgh12345678", // gitleaks:allow — synthetic emulator gRPC token
      },
      { pid: 300, avdId: "Studio_Device", serial: "emulator-5558", grpcPort: 8556, token: null },
    ]);
    expect(await readRunningEmulators(path.join(root, "none"))).toEqual([]);
  });
});

describe("system images", () => {
  it("picks the newest stable phone image for this Mac, with Google Play first", async () => {
    await systemImage("android-37.0", "google_apis", "arm64-v8a", "37.0", "17");
    await systemImage("android-37.0", "google_apis_playstore", "arm64-v8a", "37.0", "17");
    await systemImage("android-37.0", "google_apis_playstore", "x86_64", "37.0", "17");
    await systemImage("android-38", "google_apis", "arm64-v8a", "38", "Cinnamon", "Cinnamon");
    await systemImage("android-36", "android-wear", "arm64-v8a", "36", "16");
    const images = await readSystemImages(sdk());
    expect(images.map((image) => image.packageId).sort()).toEqual([
      "system-images;android-37.0;google_apis;arm64-v8a",
      "system-images;android-37.0;google_apis_playstore;arm64-v8a",
      "system-images;android-37.0;google_apis_playstore;x86_64",
      "system-images;android-38;google_apis;arm64-v8a",
    ]);
    expect(newestStableImage(images, "arm64-v8a")).toEqual({
      packageId: "system-images;android-37.0;google_apis_playstore;arm64-v8a",
      apiLevel: 37,
      release: "17",
      stable: true,
      tag: "google_apis_playstore",
      abi: "arm64-v8a",
    });
    expect(newestStableImage(images, "x86_64")?.abi).toBe("x86_64");
    expect(newestStableImage([], "arm64-v8a")).toBeNull();
  });

  it("picks the newest plain Pixel phone profile", () => {
    expect(
      newestPixelProfile("medium_phone\npixel_9\npixel_9a\npixel_10_pro\npixel_10\npixel_8\n"),
    ).toEqual({ profile: "pixel_10", name: "Pixel 10" });
    expect(newestPixelProfile("medium_phone\npixel_tablet\n")).toBeNull();
  });
});

describe("AndroidSetup", () => {
  function runner(list = "medium_phone\npixel_9\npixel_10\n") {
    const run = vi.fn<ToolRunner>(async () => ({ stdout: list, stderr: "" }));
    return run;
  }

  it("needs the emulator and adb", async () => {
    await installStudio();
    const run = runner();
    const { probe } = await new AndroidSetup({ locations, run }).probe();
    expect(probe).toEqual({
      state: "tools-missing",
      toolLabel: null,
      newDevice: null,
      studioInstalled: true,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("needs a system image for this Mac", async () => {
    await installTools();
    await systemImage("android-37.0", "google_apis", "x86_64", "37.0", "17");
    const { probe } = await new AndroidSetup({ locations, run: runner(), abi: "arm64-v8a" }).probe();
    expect(probe).toMatchObject({ state: "runtime-missing", toolLabel: "Android Emulator 37.2.12" });
  });

  it("offers a Pixel with the newest stable Android, reading profiles once", async () => {
    await installTools();
    await installStudio();
    await systemImage("android-37.0", "google_apis_playstore", "arm64-v8a", "37.0", "17");
    const run = runner();
    const setup = new AndroidSetup({ locations, run, abi: "arm64-v8a" });
    const first = await setup.probe();
    expect(first.probe).toEqual({
      state: "ready",
      toolLabel: "Android Emulator 37.2.12",
      newDevice: "Pixel 10 with Android 17",
      studioInstalled: true,
    });
    await setup.probe();
    expect(run).toHaveBeenCalledTimes(1);
    const [binary, args, options] = run.mock.calls[0]!;
    expect(binary).toBe(sdk("cmdline-tools/latest/bin/avdmanager"));
    expect(args).toEqual(["list", "device", "-c"]);
    expect(options?.env).toMatchObject({
      JAVA_HOME: path.join(root, "Android Studio.app/Contents/jbr/Contents/Home"),
      ANDROID_HOME: sdk(),
      ANDROID_AVD_HOME: locations.avdHome,
    });
  });

  it("can't make a device without Java, and asks avdmanager again after it fails", async () => {
    await installTools();
    await systemImage("android-37.0", "google_apis_playstore", "arm64-v8a", "37.0", "17");
    const run = runner();
    expect((await new AndroidSetup({ locations, run, abi: "arm64-v8a" }).probe()).probe).toMatchObject({
      state: "ready",
      newDevice: null,
      studioInstalled: false,
    });
    expect(run).not.toHaveBeenCalled();

    const failing = vi.fn<ToolRunner>(async () => {
      throw new Error("no java");
    });
    const setup = new AndroidSetup({ locations, run: failing, javaHome: "/java", abi: "arm64-v8a" });
    expect((await setup.probe()).probe.newDevice).toBeNull();
    await setup.probe();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("creating a device", () => {
  const AVDMANAGER_CONFIG = [
    "PlayStore.enabled=no",
    "avd.id=<build>",
    "avd.name=<build>",
    "disk.dataPartition.path=<temp>",
    "hw.device.name=pixel_10",
    "hw.gpu.enabled=no",
    "hw.keyboard=no",
    "hw.lcd.width=1080",
  ].join("\n");

  it("names the device, turns on the keyboard and GPU, and drops placeholders", () => {
    expect(
      patchAvdConfig(AVDMANAGER_CONFIG, { id: "Pixel_10", name: "Pixel 10", playStore: true }),
    ).toBe(
      [
        "PlayStore.enabled=true",
        "hw.device.name=pixel_10",
        "hw.gpu.enabled=yes",
        "hw.keyboard=yes",
        "hw.lcd.width=1080",
        "AvdId=Pixel_10",
        "avd.ini.displayname=Pixel 10",
        "hw.gpu.mode=auto",
        "",
      ].join("\n"),
    );
  });

  it("picks a name no device has", async () => {
    const avdHome = path.join(root, "avds");
    expect(await freeAvdName(avdHome, "Pixel 10")).toEqual({ id: "Pixel_10", name: "Pixel 10" });
    await file("avds/Pixel_10.ini", "");
    await mkdir(path.join(avdHome, "pixel_10_2.avd"), { recursive: true });
    expect(await freeAvdName(avdHome, "Pixel 10")).toEqual({
      id: "Pixel_10_3",
      name: "Pixel 10 (3)",
    });
  });

  it("runs avdmanager for the plan and patches what it wrote", async () => {
    const avdHome = path.join(root, "avds");
    const run = vi.fn<ToolRunner>(async (_file, args) => {
      const name = args[args.indexOf("--name") + 1]!;
      await file(`avds/${name}.ini`, "path=x\n");
      await file(`avds/${name}.avd/config.ini`, AVDMANAGER_CONFIG);
      return { stdout: "", stderr: "" };
    });
    const id = await createAndroidDevice(run, {
      profile: "pixel_10",
      profileName: "Pixel 10",
      image: {
        packageId: "system-images;android-37.0;google_apis_playstore;arm64-v8a",
        apiLevel: 37,
        release: "17",
        stable: true,
        tag: "google_apis_playstore",
        abi: "arm64-v8a",
      },
      avdmanager: "/sdk/cmdline-tools/latest/bin/avdmanager",
      javaHome: "/java",
      sdkRoot: "/sdk",
      avdHome,
    });
    expect(id).toBe("Pixel_10");
    const [binary, args, options] = run.mock.calls[0]!;
    expect(binary).toBe("/sdk/cmdline-tools/latest/bin/avdmanager");
    expect(args).toEqual([
      "create",
      "avd",
      "--name",
      "Pixel_10",
      "--package",
      "system-images;android-37.0;google_apis_playstore;arm64-v8a",
      "--device",
      "pixel_10",
    ]);
    expect(options).toMatchObject({
      input: "no\n",
      env: { JAVA_HOME: "/java", ANDROID_HOME: "/sdk", ANDROID_AVD_HOME: avdHome },
    });
    const config = parseIni(await readFile(path.join(avdHome, "Pixel_10.avd/config.ini"), "utf8"));
    expect(config.get("avd.ini.displayname")).toBe("Pixel 10");
    expect(config.get("hw.keyboard")).toBe("yes");
    expect(config.has("disk.dataPartition.path")).toBe(false);
  });
});
