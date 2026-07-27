// Regression tests for the 3-way `~/.zeros` split.
//
// Four call sites used to inline `isDevRuntime() ? ".zeros-dev" : ".zeros"` — a
// TWO-way split on a boolean — while EVERY other identity (data dir, workspaces,
// engine ports, keychain service, deep-link scheme) split three ways on
// `channel()`. Net effect: **Beta and Production shared `~/.zeros`.**
//
// That was not cosmetic. `~/.zeros/detach.lock` is single-instance enforcement
// (git/detach.ts:17), so with Beta holding it Production could not enter detach mode
// at all — it failed with DETACH_LOCKED naming a workspace belonging to the other
// app. `settings.toml` was one file for both. `state.db` and `worktrees/` were shared
// between two concurrently-running apps whose workspaces live in different roots.
//
// The dev instance was immune (it correctly used `.zeros-dev`), which is exactly why
// none of this was reproducible in dev.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import * as path from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { legacySharedStateRoot, zerosDotDirName, zerosStateRoot } from "../db/paths";
import { zerosStateRoot as gitStateRoot } from "../git/state";
import {
  seedUserSettingsFromLegacyRoot,
  userSettingsDir,
  userSettingsPath,
} from "../settings/files";
import { CHANNELS } from "../runtime";

const ENV = ["ZEROS_CHANNEL", "ZEROS_DEV", "ZEROS_USER_SETTINGS_DIR"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("zerosDotDirName — one leaf name per channel", () => {
  it("gives each channel its OWN dot-dir", () => {
    const seen = new Map<string, string>();
    for (const ch of CHANNELS) {
      process.env.ZEROS_CHANNEL = ch;
      seen.set(ch, zerosDotDirName());
    }
    expect(seen.get("stable")).toBe(".zeros");
    expect(seen.get("beta")).toBe(".zeros-beta");
    expect(seen.get("dev")).toBe(".zeros-dev");
  });

  it("THE regression: beta must NOT resolve to Production's `.zeros`", () => {
    process.env.ZEROS_CHANNEL = "beta";
    const beta = zerosDotDirName();
    process.env.ZEROS_CHANNEL = "stable";
    const stable = zerosDotDirName();
    expect(beta).not.toBe(stable);
  });

  it("every channel's dot-dir is pairwise distinct", () => {
    const names = CHANNELS.map((ch) => {
      process.env.ZEROS_CHANNEL = ch;
      return zerosDotDirName();
    });
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("all dot-dir consumers agree", () => {
  it("db/paths and git/state resolve the SAME root for every channel", () => {
    // Two implementations of the same concept is what allowed them to drift. They
    // now share one helper; this pins that.
    for (const ch of CHANNELS) {
      process.env.ZEROS_CHANNEL = ch;
      expect(gitStateRoot()).toBe(zerosStateRoot());
      expect(zerosStateRoot()).toBe(path.join(homedir(), zerosDotDirName()));
    }
  });

  it("userSettingsDir tracks the channel dot-dir (settings.toml is per-channel)", () => {
    for (const ch of CHANNELS) {
      process.env.ZEROS_CHANNEL = ch;
      expect(userSettingsDir()).toBe(zerosStateRoot());
    }
    // The load-bearing assertion: Beta's settings.toml is not Production's.
    process.env.ZEROS_CHANNEL = "beta";
    const betaSettings = userSettingsPath();
    process.env.ZEROS_CHANNEL = "stable";
    expect(userSettingsPath()).not.toBe(betaSettings);
  });

  it("ZEROS_USER_SETTINGS_DIR still overrides (tests / cloud sandboxes)", () => {
    process.env.ZEROS_CHANNEL = "beta";
    process.env.ZEROS_USER_SETTINGS_DIR = "/tmp/zeros-explicit";
    expect(userSettingsDir()).toBe("/tmp/zeros-explicit");
  });
});

describe("guard: nothing may reintroduce a 2-way dot-dir split", () => {
  it("no source file inlines `isDevRuntime() ? \".zeros-dev\" : \".zeros\"`", () => {
    // This exact expression, duplicated across four files, IS the bug. The whole
    // point of zerosDotDirName() is that there is one implementation keyed on
    // channel(). A new call site that inlines the boolean split would silently
    // recreate the Beta/Production collision — and, as established above, dev
    // could never reveal it. Fail here instead.
    const roots = [
      "src/engine",
      "src/zeros",
      "src/shell",
      "electron",
      "packages/core/src",
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === "__tests__") continue;
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx|cjs|mjs)$/.test(e.name)) continue;
        const src = readFileSync(p, "utf8");
        // Strip comments so the explanatory prose in paths.ts / state.ts (which
        // deliberately quotes the old expression) isn't flagged.
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/isDevRuntime\(\)\s*\?[^\n]*\.zeros-dev/.test(code)) offenders.push(p);
        if (/\.zeros-dev["'`]\s*:\s*["'`]\.zeros/.test(code)) offenders.push(p);
      }
    };
    for (const r of roots) {
      try {
        walk(r);
      } catch {
        /* root absent in this checkout — skip */
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("the dot-dir helper is keyed on channel(), not on the dev boolean", () => {
    const src = readFileSync("src/engine/db/paths.ts", "utf8");
    const fn = src.slice(
      src.indexOf("export function zerosDotDirName"),
      src.indexOf("}", src.indexOf("export function zerosDotDirName")),
    );
    expect(fn).toContain("channel()");
    expect(fn).not.toContain("isDevRuntime");
  });
});

describe("seedUserSettingsFromLegacyRoot — no config loss on upgrade", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "zeros-dotdir-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Lay out a legacy dot-dir with the given files, then run the seed against a
   *  fresh dest. Paths are INJECTED, so this exercises the real copy — driving it
   *  through ZEROS_USER_SETTINGS_DIR could only ever hit the early return. */
  function seed(files: Record<string, string>, destFiles: Record<string, string> = {}) {
    const dest = path.join(home, "dest");
    const legacy = path.join(home, "legacy");
    mkdirSync(legacy, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(legacy, name), body, "utf8");
    }
    if (Object.keys(destFiles).length > 0) {
      mkdirSync(dest, { recursive: true });
      for (const [name, body] of Object.entries(destFiles)) {
        writeFileSync(path.join(dest, name), body, "utf8");
      }
    }
    seedUserSettingsFromLegacyRoot({ dest, legacy });
    const read = (dir: string, name: string) => {
      try {
        return readFileSync(path.join(dir, name), "utf8");
      } catch {
        return null;
      }
    };
    return { dest, legacy, read };
  }

  it("COPIES settings.toml when the channel has none yet (the upgrade path)", () => {
    // THE case the function exists for: an existing Beta user whose settings lived
    // in the shared ~/.zeros before the split. Without this they silently start on
    // defaults — a regression introduced BY the split.
    const { dest, read } = seed({ "settings.toml": 'theme = "dark"\n' });
    expect(read(dest, "settings.toml")).toBe('theme = "dark"\n');
  });

  it("copies settings.managed.toml too", () => {
    const { dest, read } = seed({
      "settings.toml": "a = 1\n",
      "settings.managed.toml": "b = 2\n",
    });
    expect(read(dest, "settings.toml")).toBe("a = 1\n");
    expect(read(dest, "settings.managed.toml")).toBe("b = 2\n");
  });

  it("NEVER overwrites a file the channel already has", () => {
    // Idempotency + safety: re-running must not clobber settings the user has since
    // changed in this channel. The destination's existence IS the migration marker.
    const { dest, read } = seed(
      { "settings.toml": 'theme = "legacy"\n' },
      { "settings.toml": 'theme = "mine"\n' },
    );
    expect(read(dest, "settings.toml")).toBe('theme = "mine"\n');
  });

  it("is idempotent — a second run changes nothing", () => {
    const dest = path.join(home, "dest");
    const legacy = path.join(home, "legacy");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "settings.toml"), "a = 1\n", "utf8");
    seedUserSettingsFromLegacyRoot({ dest, legacy });
    writeFileSync(path.join(dest, "settings.toml"), "edited = true\n", "utf8");
    seedUserSettingsFromLegacyRoot({ dest, legacy });
    expect(readFileSync(path.join(dest, "settings.toml"), "utf8")).toBe(
      "edited = true\n",
    );
  });

  it("copies ONLY the settings files, leaving sibling state behind", () => {
    // state.db rows + worktrees/ paths point at the OTHER channel's workspaces root,
    // and detach.lock is a live pid lock — copying any of them corrupts.
    const { dest, read } = seed({
      "settings.toml": "a = 1\n",
      "state.db": "SQLITE",
      "detach.lock": '{"pid":1}',
    });
    expect(read(dest, "settings.toml")).toBe("a = 1\n");
    expect(read(dest, "state.db")).toBeNull();
    expect(read(dest, "detach.lock")).toBeNull();
  });

  it("is a NO-OP when an explicit settings dir is set (caller owns the location)", () => {
    const dest = path.join(home, "dest");
    const legacy = path.join(home, "legacy");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "settings.toml"), "a = 1\n", "utf8");
    process.env.ZEROS_USER_SETTINGS_DIR = dest;
    seedUserSettingsFromLegacyRoot(); // ambient — must short-circuit
    expect(() => readFileSync(path.join(dest, "settings.toml"), "utf8")).toThrow();
  });

  it("is a NO-OP for stable, whose dot-dir IS the legacy root", () => {
    process.env.ZEROS_CHANNEL = "stable";
    expect(zerosStateRoot()).toBe(legacySharedStateRoot());
    expect(() => seedUserSettingsFromLegacyRoot()).not.toThrow();
  });

  it("never throws when the legacy root does not exist", () => {
    const { dest, read } = seed({}); // legacy dir exists but is empty
    expect(read(dest, "settings.toml")).toBeNull();
    expect(() =>
      seedUserSettingsFromLegacyRoot({
        dest: path.join(home, "d2"),
        legacy: path.join(home, "definitely-absent"),
      }),
    ).not.toThrow();
  });

  it("only ever seeds settings files — never state.db / detach.lock / worktrees", () => {
    // Copying those would be actively destructive: state.db rows and worktrees/
    // paths point at the OTHER channel's workspaces root, and detach.lock is a live
    // pid lock (copying it fabricates a held lock). Pin the allowlist so a future
    // "just copy the whole dir" refactor fails here.
    const src = readFileSync(
      new URL("../settings/files.ts", import.meta.url),
      "utf8",
    );
    const block = src.slice(
      src.indexOf("const SEEDABLE_SETTINGS_FILES"),
      src.indexOf("] as const;", src.indexOf("const SEEDABLE_SETTINGS_FILES")),
    );
    expect(block).toContain("settings.toml");
    expect(block).toContain("settings.managed.toml");
    for (const forbidden of [
      "state.db",
      "detach.lock",
      "worktrees",
      "term-zdotdir",
      "agent-auth",
    ]) {
      expect(block).not.toContain(forbidden);
    }
  });
});
