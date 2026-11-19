// Pins every root the resolver hands out. Installed channels and the explicit
// overrides (cloud worker, tests) must stay byte-for-byte what they were; the
// development family and its legacy compatibility shape are the only changes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeHome = "/Users/fixture";
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  appIdentity,
  storageFamily,
  zerosCacheDir,
  zerosChannelDataDir,
  zerosDataDir,
  zerosDesignWorkspacesRoot,
  zerosDevelopmentBundleDir,
  zerosLogDir,
  zerosSessionDataDir,
  zerosStateRoot,
  zerosVisibleRoot,
  zerosWorkspacesRoot,
} from "../paths";
import { isLocalDevelopmentRuntime } from "../../runtime";

const ENV = [
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ZEROS_DATA_DIR",
  "ZEROS_WORKSPACES_DIR",
  "ZEROS_DESIGN_WORKSPACES_DIR",
  "ZEROS_DEV",
  "ZEROS_RUNTIME_MODE",
  "ZEROS_CHANNEL",
  "ZEROS_INSTANCE",
  "ZEROS_LOCAL_DEVELOPMENT",
  "ZEROS_LOCAL_LAYOUT",
] as const;
const saved: Record<string, string | undefined> = {};
const realPlatform = process.platform;

function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

beforeEach(() => {
  for (const key of ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  onPlatform(realPlatform);
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function roots() {
  return {
    family: storageFamily(),
    data: zerosDataDir(),
    shared: zerosChannelDataDir(),
    identity: appIdentity(),
    state: zerosStateRoot(),
    visible: zerosVisibleRoot(),
    workspaces: zerosWorkspacesRoot(),
    design: zerosDesignWorkspacesRoot(),
    cache: zerosCacheDir(),
    session: zerosSessionDataDir(),
    logs: zerosLogDir(),
    bundle: zerosDevelopmentBundleDir(),
  };
}

const AS = `${fakeHome}/Library/Application Support`;
const CACHES = `${fakeHome}/Library/Caches`;
const LOGS = `${fakeHome}/Library/Logs`;

describe("installed channels keep their exact layout", () => {
  it.each([
    ["stable", "com.zeros", ".zeros", "zeros"],
    ["alpha", "com.zeros.alpha", ".zeros-alpha", "zeros-alpha"],
  ])("%s on macOS, ignoring instance and layout variables", (channel, id, dot, visible) => {
    onPlatform("darwin");
    process.env.ZEROS_CHANNEL = channel;
    for (const noise of [{}, { ZEROS_INSTANCE: "a123456789abcdef", ZEROS_LOCAL_LAYOUT: "legacy" }]) {
      Object.assign(process.env, noise);
      expect(roots()).toEqual({
        family: "installed",
        data: `${AS}/${id}`,
        shared: `${AS}/${id}`,
        identity: id,
        state: `${fakeHome}/${dot}`,
        visible: `${fakeHome}/${visible}`,
        workspaces: `${fakeHome}/${visible}/workspaces`,
        design: `${fakeHome}/${visible}/design workspaces`,
        cache: `${CACHES}/${id}`,
        session: `${CACHES}/${id}`,
        logs: `${LOGS}/${id}`,
        bundle: null,
      });
    }
  });

  it.each([
    ["stable", "zeros", "com.zeros"],
    ["alpha", "zeros-alpha", "com.zeros.alpha"],
  ])("%s on Linux follows XDG and keeps logs beside the data", (channel, xdg, id) => {
    onPlatform("linux");
    process.env.ZEROS_CHANNEL = channel;
    expect(roots()).toMatchObject({
      data: `${fakeHome}/.local/share/${xdg}`,
      shared: `${fakeHome}/.local/share/${xdg}`,
      cache: `${fakeHome}/.cache/${id}`,
      logs: `${fakeHome}/.local/share/${xdg}/logs`,
    });
    process.env.XDG_DATA_HOME = "/xdg/data";
    expect(zerosDataDir()).toBe(`/xdg/data/${xdg}`);
  });

  it("uses Electron's cache root when main supplies it", () => {
    onPlatform("darwin");
    expect(zerosCacheDir("/electron/cache")).toBe("/electron/cache/com.zeros");
    expect(zerosSessionDataDir("/electron/cache")).toBe("/electron/cache/com.zeros");
  });
});

describe("explicit overrides are unchanged for every channel", () => {
  it.each(["stable", "alpha", "dev"])("%s", (channel) => {
    onPlatform("linux");
    process.env.ZEROS_CHANNEL = channel;
    process.env.ZEROS_DEV = channel === "dev" ? "1" : "";
    process.env.ZEROS_DATA_DIR = "/home/user/.zeros-data";
    process.env.ZEROS_WORKSPACES_DIR = "/home/user/owner/workspaces";
    expect(zerosDataDir()).toBe("/home/user/.zeros-data");
    expect(zerosChannelDataDir()).toBe("/home/user/.zeros-data");
    expect(zerosWorkspacesRoot()).toBe("/home/user/owner/workspaces");
    expect(zerosVisibleRoot()).toBe("/home/user/owner");
    expect(zerosDesignWorkspacesRoot()).toBe("/home/user/owner/design workspaces");
    expect(zerosLogDir()).toBe("/home/user/.zeros-data/logs");
    process.env.ZEROS_DESIGN_WORKSPACES_DIR = "/srv/design";
    expect(zerosDesignWorkspacesRoot()).toBe("/srv/design");
  });
});

describe("development family", () => {
  function dev(env: Record<string, string>) {
    onPlatform("darwin");
    Object.assign(process.env, { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev" }, env);
  }

  it("lays a new Local checkout out as one folder per kind", () => {
    dev({ ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef" });
    const inst = "a123456789abcdef";
    expect(roots()).toEqual({
      family: "development",
      data: `${AS}/com.zeros.local/instances/${inst}`,
      shared: `${AS}/com.zeros.local`,
      identity: `com.zeros.local.${inst}`,
      state: `${fakeHome}/.zeros-local/instances/${inst}`,
      visible: `${fakeHome}/zeros-local/${inst}`,
      workspaces: `${fakeHome}/zeros-local/${inst}/workspaces`,
      design: `${fakeHome}/zeros-local/${inst}/design workspaces`,
      cache: `${CACHES}/com.zeros.local/instances/${inst}`,
      session: `${CACHES}/com.zeros.local/instances/${inst}`,
      logs: `${LOGS}/com.zeros.local/${inst}`,
      bundle: `${CACHES}/com.zeros.local/bundles/${inst}`,
    });
  });

  it("resolves a legacy Local profile exactly as before the registry existed", () => {
    dev({ ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef", ZEROS_LOCAL_LAYOUT: "legacy" });
    const inst = "a123456789abcdef";
    expect(roots()).toEqual({
      family: "development",
      data: `${AS}/com.zeros.local.${inst}`,
      shared: `${AS}/com.zeros.local`,
      identity: `com.zeros.local.${inst}`,
      state: `${fakeHome}/.zeros-local/instances/${inst}`,
      visible: `${fakeHome}/zeros-local-${inst}`,
      workspaces: `${fakeHome}/zeros-local-${inst}/workspaces`,
      design: `${fakeHome}/zeros-local-${inst}/design workspaces`,
      cache: `${CACHES}/com.zeros.local.${inst}`,
      session: `${CACHES}/com.zeros.local.${inst}`,
      logs: `${LOGS}/com.zeros.local.${inst}`,
      bundle: `${fakeHome}/.zeros-local/instances/${inst}/bundle`,
    });
    onPlatform("linux");
    expect(zerosDataDir()).toBe(`${fakeHome}/.local/share/zeros-local-${inst}`);
    expect(zerosChannelDataDir()).toBe(`${fakeHome}/.local/share/zeros-local`);
    expect(zerosLogDir()).toBe(`${fakeHome}/.local/share/zeros-local-${inst}/logs`);
  });

  it("puts electron:alpha in the family without Local admission, and never in legacy", () => {
    dev({ ZEROS_INSTANCE: "alpha", ZEROS_LOCAL_LAYOUT: "legacy" });
    expect(isLocalDevelopmentRuntime()).toBe(false);
    expect(roots()).toMatchObject({
      family: "development",
      data: `${AS}/com.zeros.local/instances/alpha`,
      identity: "com.zeros.local.alpha",
      state: `${fakeHome}/.zeros-local/instances/alpha`,
      visible: `${fakeHome}/zeros-local/alpha`,
      bundle: `${CACHES}/com.zeros.local/bundles/alpha`,
    });
  });

  it("names a dev process with no instance `default`, never the retired com.zeros.dev", () => {
    dev({});
    expect(roots()).toMatchObject({
      data: `${AS}/com.zeros.local/instances/default`,
      state: `${fakeHome}/.zeros-local/instances/default`,
      logs: `${LOGS}/com.zeros.local/default`,
    });
    for (const value of Object.values(roots()))
      expect(String(value)).not.toMatch(/com\.zeros\.dev|\.zeros-dev|zeros-dev/);
  });

  it("keeps Linux and Windows shapes inside the family", () => {
    dev({ ZEROS_INSTANCE: "a123456789abcdef" });
    onPlatform("linux");
    expect(zerosDataDir()).toBe(`${fakeHome}/.local/share/zeros-local/instances/a123456789abcdef`);
    expect(zerosLogDir()).toBe(`${fakeHome}/.local/share/zeros-local/instances/a123456789abcdef/logs`);
    onPlatform("win32");
    process.env.APPDATA = "C:/Roaming";
    expect(zerosDataDir()).toBe(
      require("node:path").join("C:/Roaming", "com.zeros.local", "instances", "a123456789abcdef"),
    );
  });
});
