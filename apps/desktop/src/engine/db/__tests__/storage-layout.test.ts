// Pins every root the resolver hands out. Installed channels and the explicit
// overrides (cloud worker, tests) must stay byte-for-byte what they were; the
// development family's new identities are the only change, and its legacy
// shape resolves exactly as before.

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeHome = "/Users/fixture";
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  appIdentity,
  storageFamily,
  zerosChannelDataDir,
  zerosCredentialLockRoot,
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

const AS = `${fakeHome}/Library/Application Support`;
const CACHES = `${fakeHome}/Library/Caches`;
const LOGS = `${fakeHome}/Library/Logs`;

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
    session: zerosSessionDataDir(CACHES),
    logs: zerosLogDir(),
    bundle: zerosDevelopmentBundleDir(),
  };
}


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
      logs: `${fakeHome}/.local/share/${xdg}/logs`,
    });
    expect(zerosSessionDataDir(`${fakeHome}/.cache`)).toBe(`${fakeHome}/.cache/${id}`);
    process.env.XDG_DATA_HOME = "/xdg/data";
    expect(zerosDataDir()).toBe(`/xdg/data/${xdg}`);
  });

  it("keeps the session in Electron's own cache root, as before", () => {
    onPlatform("darwin");
    expect(zerosSessionDataDir("/electron/cache")).toBe("/electron/cache/com.zeros");
    process.env.ZEROS_CHANNEL = "alpha";
    expect(zerosSessionDataDir("/electron/cache")).toBe("/electron/cache/com.zeros.alpha");
    onPlatform("win32");
    process.env.APPDATA = "C:/Roaming";
    expect(zerosSessionDataDir("C:/Roaming")).toBe(path.join("C:/Roaming", "com.zeros.alpha"));
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
    // Installed channels keep the session in the cache root under an override,
    // as before; a development identity's session follows its data.
    expect(zerosSessionDataDir("/caches")).toBe(
      channel === "dev" ? "/home/user/.zeros-data/electron" : `/caches/${channel === "stable" ? "com.zeros" : "com.zeros.alpha"}`,
    );
    process.env.ZEROS_DESIGN_WORKSPACES_DIR = "/srv/design";
    expect(zerosDesignWorkspacesRoot()).toBe("/srv/design");
  });
});

describe("development family", () => {
  function dev(env: Record<string, string>) {
    onPlatform("darwin");
    Object.assign(process.env, { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev" }, env);
  }

  // Phase 2 finding 17: Design storage calls zerosDataDir() per chunk; a warm
  // lookup must not rebuild every development root.
  it("resolves a development identity once per exact identity inputs", () => {
    const join = vi.spyOn(path, "join");
    for (const [env, platform] of [
      [{ ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef" }, "darwin"],
      [{ ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef", ZEROS_LOCAL_LAYOUT: "legacy" }, "darwin"],
      [{ ZEROS_INSTANCE: "alpha" }, "darwin"],
      [{ ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef" }, "linux"],
    ] as const) {
      for (const key of ENV) delete process.env[key];
      dev(env);
      onPlatform(platform);
      const first = zerosDataDir();
      join.mockClear();
      expect(zerosDataDir()).toBe(first);
      expect(zerosDesignWorkspacesRoot()).toBe(roots().design);
      join.mockClear();
      for (let i = 0; i < 100; i += 1) zerosDataDir();
      expect(join, JSON.stringify(env)).not.toHaveBeenCalled();
    }
    join.mockRestore();
    // Every input that selects the identity still re-resolves it.
    for (const key of ENV) delete process.env[key];
    dev({ ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef" });
    expect(zerosDataDir()).toBe(`${AS}/com.zeros.local/instances/a123456789abcdef`);
    process.env.ZEROS_INSTANCE = "b123456789abcdef";
    expect(zerosDataDir()).toBe(`${AS}/com.zeros.local/instances/b123456789abcdef`);
    process.env.ZEROS_LOCAL_LAYOUT = "legacy";
    expect(zerosDataDir()).toBe(`${AS}/com.zeros.local.b123456789abcdef`);
    onPlatform("linux");
    process.env.XDG_DATA_HOME = "/xdg/a";
    expect(zerosDataDir()).toBe("/xdg/a/zeros-local-b123456789abcdef");
    process.env.XDG_DATA_HOME = "/xdg/b";
    expect(zerosDataDir()).toBe("/xdg/b/zeros-local-b123456789abcdef");
    expect(zerosSessionDataDir("/xdg/cache")).toBe("/xdg/cache/com.zeros.local.b123456789abcdef");
    onPlatform("win32");
    process.env.APPDATA = "C:/A";
    expect(zerosDataDir()).toBe(path.join("C:/A", "com.zeros.local.b123456789abcdef"));
  });

  // Review A finding 9: every identity keeps the Claude refresh lock root it
  // had before, so overlapping old and new engines serialize.
  it("keeps each identity's Claude refresh lock root as before", () => {
    for (const env of [
      { ZEROS_INSTANCE: "alpha" },
      { ZEROS_INSTANCE: "design-qual-0011aabb" },
      { ZEROS_INSTANCE: "alpha", ZEROS_DATA_DIR: "/tmp/evidence" },
    ] as Array<Record<string, string>>) {
      for (const key of ENV) delete process.env[key];
      dev(env);
      expect(zerosCredentialLockRoot(), JSON.stringify(env)).toBe(`${fakeHome}/.zeros-dev/credentials`);
    }
    for (const env of [
      { ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef" },
      { ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef", ZEROS_LOCAL_LAYOUT: "legacy" },
    ] as Array<Record<string, string>>) {
      for (const key of ENV) delete process.env[key];
      dev(env);
      expect(zerosCredentialLockRoot(), JSON.stringify(env)).toBe(`${fakeHome}/.zeros-local/instances/a123456789abcdef/credentials`);
    }
    for (const key of ENV) delete process.env[key];
    for (const [channel, root] of [["stable", ".zeros"], ["alpha", ".zeros-alpha"]]) {
      process.env.ZEROS_CHANNEL = channel;
      expect(zerosCredentialLockRoot()).toBe(`${fakeHome}/${root}/credentials`);
    }
  });

  it("lays a new Local checkout out as one folder per kind", () => {
    dev({ ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: "a123456789abcdef" });
    const inst = "a123456789abcdef";
    expect(roots()).toEqual({
      family: "development",
      data: `${AS}/com.zeros.local/instances/${inst}`,
      shared: `${AS}/com.zeros.local`,
      identity: `com.zeros.local.${inst}`,
      state: `${fakeHome}/.zeros-local/instances/${inst}`,
      visible: `${fakeHome}/zeros-local-${inst}`,
      workspaces: `${fakeHome}/zeros-local-${inst}/workspaces`,
      design: `${fakeHome}/zeros-local-${inst}/design workspaces`,
      session: `${AS}/com.zeros.local/instances/${inst}/electron`,
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
      visible: `${fakeHome}/zeros-local-alpha`,
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

describe("development session data", () => {
  it("follows the data dir under ZEROS_DATA_DIR for every development layout", () => {
    for (const env of [
      { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: "a123456789abcdef" },
      { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: "a123456789abcdef", ZEROS_LOCAL_LAYOUT: "legacy" },
      { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: "alpha" },
    ]) {
      for (const key of ENV) delete process.env[key];
      onPlatform("darwin");
      Object.assign(process.env, env, { ZEROS_DATA_DIR: "/fixture" });
      expect(zerosSessionDataDir("/caches"), JSON.stringify(env)).toBe("/fixture/electron");
    }
  });

  it("keeps a legacy Local session in Electron's cache root, as before", () => {
    onPlatform("darwin");
    Object.assign(process.env, { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: "a123456789abcdef", ZEROS_LOCAL_LAYOUT: "legacy" });
    expect(zerosSessionDataDir(CACHES)).toBe(`${CACHES}/com.zeros.local.a123456789abcdef`);
    delete process.env.ZEROS_LOCAL_LAYOUT;
    expect(zerosSessionDataDir(CACHES)).toBe(`${AS}/com.zeros.local/instances/a123456789abcdef/electron`);
  });
});
