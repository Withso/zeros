// Pins the roots that changed. Installed channels, hosted development and a
// legacy Local profile resolve exactly as before; only a new account-free Local
// identity gets the consolidated `com.zeros.local` layout.

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeHome = "/Users/fixture";
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  appIdentity,
  zerosChannelDataDir,
  zerosDataDir,
  zerosDesignWorkspacesRoot,
  zerosLocalLogDir,
  zerosLocalSessionDataDir,
  zerosStateRoot,
  zerosWorkspacesRoot,
} from "../paths";

const ENV = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA", "ZEROS_DATA_DIR", "ZEROS_WORKSPACES_DIR",
  "ZEROS_DESIGN_WORKSPACES_DIR", "ZEROS_DEV", "ZEROS_RUNTIME_MODE", "ZEROS_CHANNEL", "ZEROS_INSTANCE",
  "ZEROS_LOCAL_DEVELOPMENT", "ZEROS_LOCAL_LAYOUT"] as const;
const saved: Record<string, string | undefined> = {};
const realPlatform = process.platform;
const onPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: platform });
beforeEach(() => {
  for (const key of ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  onPlatform("darwin");
});
afterEach(() => {
  onPlatform(realPlatform);
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const AS = `${fakeHome}/Library/Application Support`;
const roots = () => ({
  data: zerosDataDir(),
  shared: zerosChannelDataDir(),
  identity: appIdentity(),
  state: zerosStateRoot(),
  workspaces: zerosWorkspacesRoot(),
  design: zerosDesignWorkspacesRoot(),
  session: zerosLocalSessionDataDir(),
  logs: zerosLocalLogDir(),
});
const local = (instance: string, extra: Record<string, string> = {}) =>
  Object.assign(process.env, { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev", ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_INSTANCE: instance }, extra);

describe("storage roots", () => {
  it("keeps hosted development on main's com.zeros.dev identity, primary and explicit", () => {
    Object.assign(process.env, { ZEROS_DEV: "1", ZEROS_CHANNEL: "dev" });
    expect(roots()).toEqual({
      data: `${AS}/com.zeros.dev`, shared: `${AS}/com.zeros.dev`, identity: "com.zeros.dev",
      state: `${fakeHome}/.zeros-dev`, workspaces: `${fakeHome}/zeros-dev/workspaces`,
      design: `${fakeHome}/zeros-dev/design workspaces`, session: null, logs: null,
    });
    process.env.ZEROS_INSTANCE = "design-owner-1";
    expect(roots()).toMatchObject({ data: `${AS}/com.zeros.dev.design-owner-1`, identity: "com.zeros.dev.design-owner-1",
      state: `${fakeHome}/.zeros-dev`, workspaces: `${fakeHome}/zeros-dev-design-owner-1/workspaces` });
  });

  it("lays a new Local checkout out in the consolidated family", () => {
    local("a123456789abcdef");
    const inst = "a123456789abcdef";
    // main's Local state root comes from the CommonJS helper's own homedir().
    expect(zerosStateRoot()).toMatch(new RegExp(`/\\.zeros-local/instances/${inst}$`));
    expect({ ...roots(), state: undefined }).toEqual({
      data: `${AS}/com.zeros.local/instances/${inst}`, shared: `${AS}/com.zeros.local`, identity: `com.zeros.local.${inst}`,
      state: undefined, workspaces: `${fakeHome}/zeros-local-${inst}/workspaces`,
      design: `${fakeHome}/zeros-local-${inst}/design workspaces`,
      session: `${AS}/com.zeros.local/instances/${inst}/electron`, logs: `${fakeHome}/Library/Logs/com.zeros.local/${inst}`,
    });
    onPlatform("linux");
    expect(zerosDataDir()).toBe(`${fakeHome}/.local/share/zeros-local/instances/${inst}`);
    expect(zerosLocalLogDir()).toBe(`${fakeHome}/.local/share/zeros-local/instances/${inst}/logs`);
  });

  it("resolves a legacy Local profile exactly as before", () => {
    local("a123456789abcdef", { ZEROS_LOCAL_LAYOUT: "legacy" });
    expect(roots()).toMatchObject({ data: `${AS}/com.zeros.local.a123456789abcdef`, session: null, logs: null });
  });

  it("lets ZEROS_DATA_DIR win for a new Local identity, its session following the data", () => {
    local("a123456789abcdef", { ZEROS_DATA_DIR: "/fixture" });
    expect(roots()).toMatchObject({ data: "/fixture", session: "/fixture/electron" });
  });

  // Phase 2 finding 17: Design storage resolves zerosDataDir() per chunk.
  it("resolves a new Local identity once per exact input", () => {
    local("a123456789abcdef");
    zerosDataDir();
    const join = vi.spyOn(path, "join");
    for (let i = 0; i < 100; i += 1) zerosDataDir();
    expect(join).not.toHaveBeenCalled();
    join.mockRestore();
    process.env.ZEROS_INSTANCE = "b123456789abcdef";
    expect(zerosDataDir()).toBe(`${AS}/com.zeros.local/instances/b123456789abcdef`);
    process.env.ZEROS_LOCAL_LAYOUT = "legacy";
    expect(zerosDataDir()).toBe(`${AS}/com.zeros.local.b123456789abcdef`);
    delete process.env.ZEROS_LOCAL_LAYOUT;
    onPlatform("linux");
    process.env.XDG_DATA_HOME = "/xdg/a";
    expect(zerosDataDir()).toBe("/xdg/a/zeros-local/instances/b123456789abcdef");
    process.env.XDG_DATA_HOME = "/xdg/b";
    expect(zerosDataDir()).toBe("/xdg/b/zeros-local/instances/b123456789abcdef");
  });
});
