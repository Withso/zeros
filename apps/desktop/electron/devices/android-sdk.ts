// The Android SDK, Android Studio and the virtual devices (AVDs) they made,
// read from their own files. Listing devices runs no tools; only "Create
// device" runs avdmanager.

import { access, constants, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isSimulatorDeviceId,
  type SimulatorFormFactor,
  type SimulatorScreen,
} from "@zeros/protocol/simulators";

import type { ToolRunner } from "./tool-runner";

export interface AndroidLocations {
  /** SDK folders to try; the first that exists wins. */
  sdkRoots: string[];
  avdHome: string;
  /** Where each running emulator writes a `pid_<pid>.ini`. */
  runningDir: string;
  studioApps: string[];
}

function absolute(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value) ? value : null;
}

/** Where the emulator and Android Studio keep things, as they work it out. */
export function androidLocations(env: NodeJS.ProcessEnv, home: string): AndroidLocations {
  const sdkRoots = [
    absolute(env.ANDROID_HOME),
    absolute(env.ANDROID_SDK_ROOT),
    path.join(home, "Library", "Android", "sdk"),
  ].filter((root): root is string => root !== null);
  const sdkHome = absolute(env.ANDROID_SDK_HOME);
  const userHome =
    absolute(env.ANDROID_USER_HOME) ??
    (sdkHome ? path.join(sdkHome, ".android") : path.join(home, ".android"));
  return {
    sdkRoots: [...new Set(sdkRoots)],
    avdHome: absolute(env.ANDROID_AVD_HOME) ?? path.join(userHome, "avd"),
    runningDir: path.join(home, "Library", "Caches", "TemporaryItems", "avd", "running"),
    studioApps: [
      "/Applications/Android Studio.app",
      path.join(home, "Applications", "Android Studio.app"),
    ],
  };
}

/** `key=value` lines, as AVD and SDK files write them. */
export function parseIni(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    entries.set(trimmed.slice(0, equals).trim(), trimmed.slice(equals + 1).trim());
  }
  return entries;
}

async function readIni(file: string): Promise<Map<string, string> | null> {
  try {
    return parseIni(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  return stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function executable(file: string): Promise<string | null> {
  try {
    await access(file, constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export interface AndroidSdk {
  root: string;
  emulator: string | null;
  adb: string | null;
  avdmanager: string | null;
  /** Such as "37.2.12". */
  emulatorVersion: string | null;
}

/** The newest command-line tools' avdmanager; `latest` is what Android
 * Studio installs. */
async function findAvdmanager(root: string): Promise<string | null> {
  const tools = path.join(root, "cmdline-tools");
  const latest = await executable(path.join(tools, "latest", "bin", "avdmanager"));
  if (latest) return latest;
  const versions = await readdir(tools).catch(() => [] as string[]);
  for (const version of versions.filter((entry) => /^\d/.test(entry)).sort(compareVersions).reverse()) {
    const found = await executable(path.join(tools, version, "bin", "avdmanager"));
    if (found) return found;
  }
  return null;
}

export async function findAndroidSdk(locations: AndroidLocations): Promise<AndroidSdk | null> {
  for (const root of locations.sdkRoots) {
    if (!(await isDirectory(root))) continue;
    const [emulator, adb, avdmanager, properties] = await Promise.all([
      executable(path.join(root, "emulator", "emulator")),
      executable(path.join(root, "platform-tools", "adb")),
      findAvdmanager(root),
      readIni(path.join(root, "emulator", "source.properties")),
    ]);
    const revision = properties?.get("Pkg.Revision") ?? null;
    return {
      root,
      emulator,
      adb,
      avdmanager,
      emulatorVersion: revision && /^\d+(\.\d+){0,3}$/.test(revision) ? revision : null,
    };
  }
  return null;
}

export interface AndroidStudio {
  app: string;
  /** Its own Java, which runs avdmanager. */
  javaHome: string | null;
  /** Its device frames, one folder per hardware profile. */
  deviceArt: string | null;
}

export async function findAndroidStudio(
  locations: AndroidLocations,
): Promise<AndroidStudio | null> {
  for (const app of locations.studioApps) {
    if (!(await isDirectory(app))) continue;
    let javaHome: string | null = null;
    for (const runtime of ["jbr", "jre"]) {
      const candidate = path.join(app, "Contents", runtime, "Contents", "Home");
      if (await executable(path.join(candidate, "bin", "java"))) {
        javaHome = candidate;
        break;
      }
    }
    const art = path.join(app, "Contents", "plugins", "android", "resources", "device-art-resources");
    return { app, javaHome, deviceArt: (await isDirectory(art)) ? art : null };
  }
  return null;
}

// ── Virtual devices ──────────────────────────────────────

export interface AndroidAvd {
  /** The name `emulator -avd` takes: its `.ini` file's name. */
  id: string;
  name: string;
  /** The hardware profile it was made from, such as "pixel_10", which
   * names its Android Studio frame. */
  profile: string | null;
  /** Its screen; the corner radius comes from the frame. */
  screen: Omit<SimulatorScreen, "cornerRadius"> | null;
  formFactor: SimulatorFormFactor;
  /** Such as "Android 17". */
  osLabel: string;
  apiLevel: number;
  /** Its own graphics setting (`hw.gpu.mode`), such as "auto" or "host",
   * or null when it has none. */
  gpuMode: string | null;
}

/** Watches, TVs, cars, desktops and headsets aren't phones or tablets. */
const OTHER_DEVICE_TAG = /wear|tv|automotive|desktop|xr|glasses/i;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const MAX_AVDS = 100;

function positiveInt(value: string | undefined): number | null {
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const number = Number(value);
  return number > 0 ? number : null;
}

/** Points are Android's density-independent pixels: 160 per inch. */
export function androidScreen(
  config: Map<string, string>,
): Omit<SimulatorScreen, "cornerRadius"> | null {
  const widthPx = positiveInt(config.get("hw.lcd.width"));
  const heightPx = positiveInt(config.get("hw.lcd.height"));
  const density = positiveInt(config.get("hw.lcd.density"));
  if (!widthPx || !heightPx || !density || widthPx > 10_000 || heightPx > 10_000) return null;
  return { widthPx, heightPx, scale: Math.min(4, Math.max(1, density / 160)) };
}

/** Android's own line between the two: a tablet is 600 points across its
 * shorter side. */
function formFactorOf(screen: Omit<SimulatorScreen, "cornerRadius"> | null): SimulatorFormFactor {
  if (!screen) return "phone";
  return Math.min(screen.widthPx, screen.heightPx) / screen.scale >= 600 ? "tablet" : "phone";
}

interface ImageVersion {
  apiLevel: number;
  release: string | null;
  stable: boolean;
}

async function readImageVersion(imageDir: string): Promise<ImageVersion | null> {
  const [source, build] = await Promise.all([
    readIni(path.join(imageDir, "source.properties")),
    readIni(path.join(imageDir, "build.prop")),
  ]);
  const apiLevel = Number.parseFloat(source?.get("AndroidVersion.ApiLevel") ?? "");
  if (!Number.isFinite(apiLevel) || apiLevel <= 0) return null;
  const release =
    build?.get("ro.build.version.release_or_codename") ?? build?.get("ro.build.version.release");
  const codename = build?.get("ro.build.version.codename");
  return {
    apiLevel,
    release: release && /^[A-Za-z0-9.]{1,20}$/.test(release) ? release : null,
    stable: codename === "REL" && !source?.has("AndroidVersion.CodeName"),
  };
}

function osLabelOf(version: ImageVersion | null, target: string | undefined): string {
  if (version?.release) return `Android ${version.release}`;
  if (version) return `Android API ${version.apiLevel}`;
  const api = /^android-(\d+(?:\.\d+)?)$/.exec(target ?? "")?.[1];
  return api ? `Android API ${api}` : "Android";
}

function displayName(config: Map<string, string>, id: string): string {
  const name = config.get("avd.ini.displayname")?.trim();
  return (name && name.length <= 120 ? name : id.replace(/_/g, " ")).slice(0, 120);
}

/** The phone and tablet AVDs in `avdHome`, newest Android first, then
 * phones before tablets, then by name. */
export async function readAvds(sdkRoot: string | null, avdHome: string): Promise<AndroidAvd[]> {
  const entries = await readdir(avdHome).catch(() => [] as string[]);
  const ids = entries
    .filter((entry) => entry.endsWith(".ini"))
    .map((entry) => entry.slice(0, -4))
    .filter(isSimulatorDeviceId)
    .slice(0, MAX_AVDS);
  const avds = await Promise.all(
    ids.map(async (id): Promise<AndroidAvd | null> => {
      const pointer = await readIni(path.join(avdHome, `${id}.ini`));
      if (!pointer) return null;
      const candidates = [
        absolute(pointer.get("path")),
        pointer.get("path.rel") ? path.join(path.dirname(avdHome), pointer.get("path.rel")!) : null,
        path.join(avdHome, `${id}.avd`),
      ].filter((dir): dir is string => dir !== null);
      let config: Map<string, string> | null = null;
      for (const dir of candidates) {
        config = await readIni(path.join(dir, "config.ini"));
        if (config) break;
      }
      if (!config || OTHER_DEVICE_TAG.test(config.get("tag.id") ?? "")) return null;
      const sysdir = config.get("image.sysdir.1");
      const version =
        sdkRoot && sysdir && !path.isAbsolute(sysdir) && !sysdir.split(/[\\/]/).includes("..")
          ? await readImageVersion(path.join(sdkRoot, sysdir))
          : null;
      const screen = androidScreen(config);
      const profile = config.get("hw.device.name");
      return {
        id,
        name: displayName(config, id),
        profile: profile && PROFILE.test(profile) ? profile : null,
        screen,
        formFactor: formFactorOf(screen),
        osLabel: osLabelOf(version, config.get("target") ?? pointer.get("target")),
        apiLevel: version?.apiLevel ?? 0,
        gpuMode: config.get("hw.gpu.mode")?.trim().toLowerCase() || null,
      };
    }),
  );
  return avds
    .filter((avd): avd is AndroidAvd => avd !== null)
    .sort(
      (a, b) =>
        b.apiLevel - a.apiLevel ||
        Number(a.formFactor === "tablet") - Number(b.formFactor === "tablet") ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}

// ── Running emulators ────────────────────────────────────

export interface RunningEmulator {
  pid: number;
  avdId: string;
  /** adb's name for it, such as "emulator-5554". */
  serial: string | null;
  grpcPort: number | null;
  /** Only an emulator started with `-grpc-use-token`, as Zeros starts
   * them, has one. A secret: never logged. */
  token: string | null;
}

function port(value: string | undefined): number | null {
  const number = positiveInt(value);
  return number !== null && number < 65_536 ? number : null;
}

export function readRunningIni(pid: number, ini: Map<string, string>): RunningEmulator | null {
  const avdId = ini.get("avd.id");
  if (!isSimulatorDeviceId(avdId)) return null;
  const serialPort = port(ini.get("port.serial"));
  const token = ini.get("grpc.token");
  return {
    pid,
    avdId,
    serial: serialPort === null ? null : `emulator-${serialPort}`,
    grpcPort: port(ini.get("grpc.port")),
    token: token && /^[\x21-\x7e]{8,512}$/.test(token) ? token : null,
  };
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Emulators that are running now. A crashed one leaves its file behind,
 * so each one's process must still be alive. */
export async function readRunningEmulators(
  runningDir: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<RunningEmulator[]> {
  const entries = await readdir(runningDir).catch(() => [] as string[]);
  const found = await Promise.all(
    entries.map(async (entry) => {
      const match = /^pid_(\d{1,9})\.ini$/.exec(entry);
      const pid = match ? Number(match[1]) : 0;
      if (!pid || !alive(pid)) return null;
      const ini = await readIni(path.join(runningDir, entry));
      return ini ? readRunningIni(pid, ini) : null;
    }),
  );
  return found.filter((emulator): emulator is RunningEmulator => emulator !== null);
}

// ── System images ────────────────────────────────────────

export interface AndroidSystemImage {
  /** sdkmanager's name for it, such as
   * "system-images;android-37.0;google_apis_playstore;arm64-v8a". */
  packageId: string;
  apiLevel: number;
  /** Such as "17". */
  release: string | null;
  stable: boolean;
  tag: string;
  abi: string;
}

/** Phone and tablet images, best first: Google Play, then Google APIs,
 * then plain Android. */
const PHONE_TAGS = ["google_apis_playstore", "google_apis", "default"];
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

export function hostAbi(arch: string = process.arch): string {
  return arch === "arm64" ? "arm64-v8a" : "x86_64";
}

export async function readSystemImages(sdkRoot: string): Promise<AndroidSystemImage[]> {
  const root = path.join(sdkRoot, "system-images");
  const images: AndroidSystemImage[] = [];
  for (const platform of await readdir(root).catch(() => [] as string[])) {
    if (!SEGMENT.test(platform)) continue;
    for (const tag of await readdir(path.join(root, platform)).catch(() => [] as string[])) {
      if (!PHONE_TAGS.includes(tag)) continue;
      for (const abi of await readdir(path.join(root, platform, tag)).catch(() => [] as string[])) {
        if (!SEGMENT.test(abi)) continue;
        const version = await readImageVersion(path.join(root, platform, tag, abi));
        if (!version) continue;
        images.push({
          packageId: ["system-images", platform, tag, abi].join(";"),
          apiLevel: version.apiLevel,
          release: version.release,
          stable: version.stable,
          tag,
          abi,
        });
      }
    }
  }
  return images;
}

/** The image "Create device" uses: the newest stable Android this Mac runs
 * natively, with Google Play if it can. */
export function newestStableImage(
  images: readonly AndroidSystemImage[],
  abi: string = hostAbi(),
): AndroidSystemImage | null {
  const usable = images.filter((image) => image.stable && image.abi === abi);
  usable.sort(
    (a, b) => b.apiLevel - a.apiLevel || PHONE_TAGS.indexOf(a.tag) - PHONE_TAGS.indexOf(b.tag),
  );
  return usable[0] ?? null;
}

// ── Setup ────────────────────────────────────────────────

export interface AndroidSetupProbe {
  state: "ready" | "tools-missing" | "runtime-missing";
  /** Such as "Android Emulator 37.2.12". */
  toolLabel: string | null;
  /** Such as "Pixel 10 with Android 17", or null when Zeros can't make
   * one. */
  newDevice: string | null;
  studioInstalled: boolean;
}

/** Everything "Create device" needs, when this Mac has it. */
export interface NewDevicePlan {
  /** The hardware profile, such as "pixel_10". */
  profile: string;
  /** Such as "Pixel 10". */
  profileName: string;
  image: AndroidSystemImage;
  avdmanager: string;
  javaHome: string;
  sdkRoot: string;
  avdHome: string;
}

export function newDeviceLabel(plan: NewDevicePlan): string {
  return `${plan.profileName} with Android ${plan.image.release ?? `API ${plan.image.apiLevel}`}`;
}

/** The newest plain Pixel phone in `avdmanager list device -c`, such as
 * "pixel_10" over "pixel_9a" or "pixel_10_pro". */
export function newestPixelProfile(compactList: string): { profile: string; name: string } | null {
  let best: { profile: string; name: string; number: number } | null = null;
  for (const line of compactList.split(/\r?\n/)) {
    const match = /^pixel_(\d{1,3})$/.exec(line.trim());
    if (!match) continue;
    const number = Number(match[1]);
    if (!best || number > best.number) {
      best = { profile: line.trim(), name: `Pixel ${number}`, number };
    }
  }
  return best && { profile: best.profile, name: best.name };
}

export interface AndroidSetupContext {
  locations: AndroidLocations;
  run: ToolRunner;
  /** Java for avdmanager when Android Studio has none. */
  javaHome?: string | null;
  abi?: string;
}

/** Reads Android's setup, and what "Create device" would make. The device
 * profile list comes from avdmanager once per avdmanager. */
export class AndroidSetup {
  private profiles = new Map<string, Promise<{ profile: string; name: string } | null>>();

  constructor(private readonly context: AndroidSetupContext) {}

  async probe(): Promise<{ probe: AndroidSetupProbe; sdk: AndroidSdk | null; studio: AndroidStudio | null; plan: NewDevicePlan | null }> {
    const [sdk, studio] = await Promise.all([
      findAndroidSdk(this.context.locations),
      findAndroidStudio(this.context.locations),
    ]);
    const studioInstalled = studio !== null;
    if (!sdk?.emulator || !sdk.adb) {
      return {
        probe: { state: "tools-missing", toolLabel: null, newDevice: null, studioInstalled },
        sdk,
        studio,
        plan: null,
      };
    }
    const toolLabel = sdk.emulatorVersion ? `Android Emulator ${sdk.emulatorVersion}` : null;
    const images = await readSystemImages(sdk.root);
    const abi = this.context.abi ?? hostAbi();
    if (!images.some((image) => image.abi === abi)) {
      return {
        probe: { state: "runtime-missing", toolLabel, newDevice: null, studioInstalled },
        sdk,
        studio,
        plan: null,
      };
    }
    const plan = await this.plan(sdk, studio, images, abi);
    return {
      probe: {
        state: "ready",
        toolLabel,
        newDevice: plan ? newDeviceLabel(plan) : null,
        studioInstalled,
      },
      sdk,
      studio,
      plan,
    };
  }

  private async plan(
    sdk: AndroidSdk,
    studio: AndroidStudio | null,
    images: readonly AndroidSystemImage[],
    abi: string,
  ): Promise<NewDevicePlan | null> {
    const image = newestStableImage(images, abi);
    const javaHome = studio?.javaHome ?? this.context.javaHome ?? null;
    if (!image || !sdk.avdmanager || !javaHome) return null;
    const avdmanager = sdk.avdmanager;
    let profile = this.profiles.get(avdmanager);
    if (!profile) {
      profile = this.context
        .run(avdmanager, ["list", "device", "-c"], {
          timeoutMs: 30_000,
          env: avdmanagerEnvironment(javaHome, sdk.root, this.context.locations.avdHome),
        })
        .then(
          ({ stdout }) => newestPixelProfile(stdout),
          () => null,
        );
      this.profiles.set(avdmanager, profile);
      void profile.then((found) => {
        if (!found) this.profiles.delete(avdmanager);
      });
    }
    const found = await profile;
    if (!found) return null;
    return {
      profile: found.profile,
      profileName: found.name,
      image,
      avdmanager,
      javaHome,
      sdkRoot: sdk.root,
      avdHome: this.context.locations.avdHome,
    };
  }
}

export function avdmanagerEnvironment(
  javaHome: string,
  sdkRoot: string,
  avdHome: string,
): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME,
    ...(process.env.ANDROID_USER_HOME ? { ANDROID_USER_HOME: process.env.ANDROID_USER_HOME } : {}),
    JAVA_HOME: javaHome,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    ANDROID_AVD_HOME: avdHome,
  };
}

/** A free AVD id and display name for a profile, such as "Pixel_10" and
 * "Pixel 10", then "Pixel_10_2" and "Pixel 10 (2)". */
export async function freeAvdName(
  avdHome: string,
  profileName: string,
): Promise<{ id: string; name: string }> {
  const base = profileName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Android";
  const taken = new Set(
    (await readdir(avdHome).catch(() => [] as string[])).map((entry) =>
      entry.replace(/\.(ini|avd)$/, "").toLowerCase(),
    ),
  );
  for (let copy = 1; copy < 100; copy++) {
    const id = copy === 1 ? base : `${base}_${copy}`;
    if (!taken.has(id.toLowerCase())) {
      return { id, name: copy === 1 ? profileName : `${profileName} (${copy})` };
    }
  }
  throw new Error("Too many devices with this name.");
}

/** avdmanager's config, made to work like a device from Android Studio's
 * Device Manager: named, with the Mac's keyboard and GPU, and none of the
 * placeholder values avdmanager writes. */
export function patchAvdConfig(
  config: string,
  values: { id: string; name: string; playStore: boolean },
): string {
  const set = new Map<string, string>([
    ["AvdId", values.id],
    ["avd.ini.displayname", values.name],
    ["PlayStore.enabled", values.playStore ? "true" : "false"],
    ["hw.keyboard", "yes"],
    ["hw.gpu.enabled", "yes"],
    ["hw.gpu.mode", "auto"],
  ]);
  const lines: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    const key = equals > 0 ? line.slice(0, equals).trim() : "";
    const value = equals > 0 ? line.slice(equals + 1).trim() : "";
    if (!key) {
      if (line.trim()) lines.push(line);
      continue;
    }
    if (/^<[a-z]+>$/.test(value)) continue;
    if (set.has(key)) {
      lines.push(`${key}=${set.get(key)}`);
      set.delete(key);
      continue;
    }
    lines.push(line);
  }
  for (const [key, value] of set) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

/** Makes the planned device and returns its id. */
export async function createAndroidDevice(
  run: ToolRunner,
  plan: NewDevicePlan,
): Promise<string> {
  const { id, name } = await freeAvdName(plan.avdHome, plan.profileName);
  await run(
    plan.avdmanager,
    ["create", "avd", "--name", id, "--package", plan.image.packageId, "--device", plan.profile],
    {
      timeoutMs: 120_000,
      // "Do you wish to create a custom hardware profile?"
      input: "no\n",
      env: avdmanagerEnvironment(plan.javaHome, plan.sdkRoot, plan.avdHome),
    },
  );
  const configFile = path.join(plan.avdHome, `${id}.avd`, "config.ini");
  const config = await readFile(configFile, "utf8");
  const patched = `${configFile}.zeros-${process.pid}`;
  await writeFile(
    patched,
    patchAvdConfig(config, { id, name, playStore: plan.image.tag === "google_apis_playstore" }),
  );
  await rename(patched, configFile);
  return id;
}
