import { describe, expect, it } from "vitest";

import {
  isSameDevInstanceOrphan,
  parseProcessTable,
  processHasEnvironmentAssignment,
  shouldReapRangeListener,
  splitProcessCommand,
} from "../../../electron/orphan-engines";

describe("dev orphan engine matching", () => {
  const cliPath = "/Users/dev/Projects/zeros/worktree-a/src/cli.ts";
  const command =
    `/opt/homebrew/bin/bun ${cliPath} serve ` +
    "--root /Users/dev/Projects/zeros --port 25803";

  it("parses pid, parent pid, and the full command from ps output", () => {
    expect(
      parseProcessTable(
        `  6330     1 ${command}\n 98432 88391 ${command}\nnoise`,
      ),
    ).toEqual([
      { pid: 6330, ppid: 1, command },
      { pid: 98432, ppid: 88391, command },
    ]);
  });

  it("preserves quoted and escaped paths when splitting ps commands", () => {
    expect(
      splitProcessCommand(
        `/opt/homebrew/bin/bun "/Users/dev/Zeros copy/src/cli.ts" serve ` +
          "--root /Users/dev/My\\ Repo --port 25803",
      ),
    ).toEqual([
      "/opt/homebrew/bin/bun",
      "/Users/dev/Zeros copy/src/cli.ts",
      "serve",
      "--root",
      "/Users/dev/My Repo",
      "--port",
      "25803",
    ]);
  });

  it("matches only a parentless Bun engine with the exact CLI and instance", () => {
    expect(
      isSameDevInstanceOrphan(
        { pid: 6330, ppid: 1, command },
        {
          cliPath,
          instance: "instant-loading-a1b2",
          processWithEnvironment:
            `${command} ZEROS_INSTANCE=instant-loading-a1b2 ` +
            "ZEROS_ENGINE_BASE_PORT=25803",
        },
      ),
    ).toBe(true);

    const base = {
      cliPath,
      instance: "instant-loading-a1b2",
      processWithEnvironment: `${command} ZEROS_INSTANCE=instant-loading-a1b2`,
    };
    expect(
      isSameDevInstanceOrphan({ pid: 6330, ppid: 99, command }, base),
    ).toBe(false);
    expect(
      isSameDevInstanceOrphan(
        {
          pid: 6330,
          ppid: 1,
          command: command.replace("worktree-a", "worktree-b"),
        },
        base,
      ),
    ).toBe(false);
    expect(
      isSameDevInstanceOrphan(
        { pid: 6330, ppid: 1, command },
        {
          ...base,
          processWithEnvironment: `${command} ZEROS_INSTANCE=instant-loading-a1b20`,
        },
      ),
    ).toBe(false);
    expect(
      isSameDevInstanceOrphan(
        { pid: 6330, ppid: 1, command },
        { ...base, skipPid: 6330 },
      ),
    ).toBe(false);
  });

  it("matches environment assignments as exact tokens", () => {
    expect(
      processHasEnvironmentAssignment(
        "bun cli ZEROS_INSTANCE=zeros-a OTHER=1",
        "ZEROS_INSTANCE",
        "zeros-a",
      ),
    ).toBe(true);
    expect(
      processHasEnvironmentAssignment(
        "bun cli ZEROS_INSTANCE=zeros-ab OTHER=1",
        "ZEROS_INSTANCE",
        "zeros-a",
      ),
    ).toBe(false);
  });
});

describe("range-listener reaping (shouldReapRangeListener)", () => {
  const packagedEngine =
    "/Applications/Zeros Beta.app/Contents/Resources/zeros-engine serve --root /Users/dev/proj --port 24193";
  const devEngine =
    "/opt/homebrew/bin/bun /Users/dev/Zeros/src/cli.ts serve --root /Users/dev/proj --port 24293";
  const ptyHost =
    "/Applications/Zeros Beta.app/Contents/MacOS/Zeros Beta /Applications/Zeros Beta.app/Contents/Resources/pty-host.cjs";
  const cursorHost =
    "/Applications/Zeros.app/Contents/MacOS/Zeros /Applications/Zeros.app/Contents/Resources/cursor-host.cjs";

  it("reaps orphaned (ppid 1) engines, packaged and dev", () => {
    expect(shouldReapRangeListener({ command: packagedEngine, ppid: 1 })).toBe(true);
    expect(shouldReapRangeListener({ command: devEngine, ppid: 1 })).toBe(true);
  });

  it("spares an engine whose parent is still alive (sibling channel, CLI under a shell, mid-graceful-quit)", () => {
    expect(shouldReapRangeListener({ command: packagedEngine, ppid: 843 })).toBe(false);
    expect(shouldReapRangeListener({ command: devEngine, ppid: 70211 })).toBe(false);
  });

  it("fails closed when the ppid lookup failed", () => {
    expect(shouldReapRangeListener({ command: packagedEngine, ppid: null })).toBe(false);
  });

  it("reaps orphaned hosts holding the dead engine's inherited listen socket", () => {
    expect(shouldReapRangeListener({ command: ptyHost, ppid: 1 })).toBe(true);
    expect(shouldReapRangeListener({ command: cursorHost, ppid: 1 })).toBe(true);
  });

  it("spares a live engine's hosts (ppid = the engine) and hosts with unknown ppid", () => {
    expect(shouldReapRangeListener({ command: ptyHost, ppid: 53861 })).toBe(false);
    expect(shouldReapRangeListener({ command: cursorHost, ppid: null })).toBe(false);
  });

  it("never matches unrelated processes, even orphaned ones in the range", () => {
    expect(
      shouldReapRangeListener({ command: "/usr/libexec/some-daemon --port 24193", ppid: 1 }),
    ).toBe(false);
    expect(shouldReapRangeListener({ command: "", ppid: 1 })).toBe(false);
  });
});
