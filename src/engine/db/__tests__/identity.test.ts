// The single-identity resolver (Phase 0 of the storage-architecture unification).
// zerosDataDir() naming is covered by agents/__tests__/session-paths.test.ts; this
// pins the NEW exports that electron/main.ts relies on to fold Electron's userData,
// cache, logs + the shared-secrets dir onto ONE reverse-DNS id per (channel,
// instance) — so a future refactor breaks the suite, not the user's disk layout.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// homedir() is non-configurable on the imported namespace, so stub node:os before
// importing paths. zerosChannelDataDir()/zerosStateRoot() read it; appIdentity()
// doesn't (pure reverse-DNS), so its assertions are homedir-independent.
let fakeHome = "/fake/home";
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  appIdentity,
  zerosChannelDataDir,
  zerosDataDir,
  zerosStateRoot,
} from "../paths";

const STEERING_ENV = [
  "XDG_DATA_HOME",
  "APPDATA",
  "ZEROS_DATA_DIR",
  "ZEROS_DEV",
  "ZEROS_RUNTIME_MODE",
  "ZEROS_CHANNEL",
  "ZEROS_INSTANCE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of STEERING_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of STEERING_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("appIdentity() — one reverse-DNS id per (channel, instance)", () => {
  it("stable → com.zeros", () => {
    expect(appIdentity()).toBe("com.zeros");
  });

  it("dev primary → com.zeros.dev", () => {
    process.env.ZEROS_DEV = "1";
    expect(appIdentity()).toBe("com.zeros.dev");
  });

  it("dev worktree → com.zeros.dev.<slug>", () => {
    process.env.ZEROS_DEV = "1";
    process.env.ZEROS_INSTANCE = "san-francisco";
    expect(appIdentity()).toBe("com.zeros.dev.san-francisco");
  });

  it("beta → com.zeros.beta, and IGNORES ZEROS_INSTANCE (single app)", () => {
    process.env.ZEROS_CHANNEL = "beta";
    process.env.ZEROS_INSTANCE = "san-francisco";
    expect(appIdentity()).toBe("com.zeros.beta");
  });
});

describe("zerosChannelDataDir() — the slug-stripped shared-secrets home", () => {
  it("equals zerosDataDir() when there is no instance (stable + dev primary)", () => {
    expect(zerosChannelDataDir()).toBe(zerosDataDir());
    process.env.ZEROS_DEV = "1";
    expect(zerosChannelDataDir()).toBe(zerosDataDir());
  });

  it("strips the slug so every dev worktree shares ONE secrets home", () => {
    process.env.ZEROS_DEV = "1";
    const primary = zerosChannelDataDir(); // no instance yet
    process.env.ZEROS_INSTANCE = "san-francisco";
    // The per-worktree data dir carries the slug…
    expect(zerosDataDir()).toMatch(/san-francisco$/);
    // …but the channel-primary dir does NOT, and equals the plain-dev dir, so
    // every worktree resolves the SAME shared secrets.json location.
    expect(zerosChannelDataDir()).not.toMatch(/san-francisco/);
    expect(zerosChannelDataDir()).toBe(primary);
  });
});

describe("zerosStateRoot() — dev-aware dot-dir (no prod pollution)", () => {
  it("prod → ~/.zeros, dev → ~/.zeros-dev, and they are disjoint", () => {
    expect(zerosStateRoot()).toBe(`${fakeHome}/.zeros`);
    process.env.ZEROS_DEV = "1";
    expect(zerosStateRoot()).toBe(`${fakeHome}/.zeros-dev`);
  });
});
