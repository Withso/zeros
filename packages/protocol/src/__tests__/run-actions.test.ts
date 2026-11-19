// Run actions — shared parser/normalizer + session-id scheme. Both sides of
// the bridge (engine RunManager + renderer run tabs) consume exactly these,
// so the invariants here are the wire contract: skip-don't-drop validation,
// one-default normalization, the legacy `scripts.run` read-time migration,
// and the legacy-compatible session-id hash.

import { describe, it, expect } from "vitest";

import {
  filterRunActionsForPlatform,
  isOneShotCommand,
  isRunSessionId,
  LEGACY_RUN_ACTION_ID,
  parseRunActions,
  runActionOneShot,
  runSessionId,
} from "../run-actions";

describe("parseRunActions", () => {
  it("parses valid entries, skipping invalid ones (never the whole list)", () => {
    const actions = parseRunActions({
      run_actions: [
        { id: "dev", name: "Dev", command: "pnpm dev" },
        { id: "", name: "Broken", command: "x" }, // missing id → skipped
        { id: "test", name: "Test" }, // missing command → skipped
        "not a table", // skipped
        { id: "sb", name: "Storybook", command: "pnpm storybook", icon: "globe" },
      ],
    });
    expect(actions.map((a) => a.id)).toEqual(["dev", "sb"]);
    expect(actions[1]!.icon).toBe("globe");
  });

  it("keeps the FIRST occurrence of a duplicate id", () => {
    const actions = parseRunActions({
      run_actions: [
        { id: "dev", name: "Dev", command: "pnpm dev" },
        { id: "dev", name: "Dev 2", command: "pnpm dev2" },
      ],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.name).toBe("Dev");
  });

  it("normalizes to exactly one default — the first flagged, else the first", () => {
    const flagged = parseRunActions({
      run_actions: [
        { id: "a", name: "A", command: "a" },
        { id: "b", name: "B", command: "b", default: true },
        { id: "c", name: "C", command: "c", default: true },
      ],
    });
    expect(flagged.map((a) => a.isDefault)).toEqual([false, true, false]);
    const unflagged = parseRunActions({
      run_actions: [
        { id: "a", name: "A", command: "a" },
        { id: "b", name: "B", command: "b" },
      ],
    });
    expect(unflagged.map((a) => a.isDefault)).toEqual([true, false]);
  });

  it("migrates the legacy scripts.run string to one default 'run' action", () => {
    const actions = parseRunActions({ run: "pnpm dev" });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: LEGACY_RUN_ACTION_ID,
      name: "Run",
      command: "pnpm dev",
      isDefault: true,
    });
  });

  it("run_actions supersede the legacy string; nothing configured → []", () => {
    expect(
      parseRunActions({
        run: "legacy",
        run_actions: [{ id: "dev", name: "Dev", command: "pnpm dev" }],
      }).map((a) => a.id),
    ).toEqual(["dev"]);
    expect(parseRunActions({})).toEqual([]);
    expect(parseRunActions(undefined)).toEqual([]);
  });

  it("an EXPLICIT empty run_actions means 'none' — the legacy string must not resurrect a deleted action", () => {
    expect(parseRunActions({ run: "pnpm dev", run_actions: [] })).toEqual([]);
  });

  it("drops unknown platform values instead of the entry", () => {
    const [a] = parseRunActions({
      run_actions: [
        { id: "d", name: "D", command: "d", platforms: ["mac", "amiga"] },
      ],
    });
    expect(a!.platforms).toEqual(["mac"]);
  });
});

describe("runSessionId", () => {
  it("keeps the legacy unsuffixed id for the migrated 'run' action", () => {
    // The exact djb2 output the renderer's original runSessionId produced —
    // persisted run terminals must keep matching after the move to core.
    expect(runSessionId("/w")).toBe(runSessionId("/w", LEGACY_RUN_ACTION_ID));
    expect(runSessionId("/w")).toMatch(/^pty-run-[a-z0-9]+$/);
  });

  it("suffixes other actions and keeps ids id-shaped", () => {
    expect(runSessionId("/w", "dev")).toBe(`${runSessionId("/w")}-dev`);
    expect(runSessionId("/w", "weird id!")).toBe(
      `${runSessionId("/w")}-weird-id-`,
    );
    expect(runSessionId("/w", "dev")).not.toBe(runSessionId("/other", "dev"));
    expect(isRunSessionId(runSessionId("/w", "dev"))).toBe(true);
  });
});

describe("one-shot heuristic", () => {
  it("long-lived markers win over one-shot ones; unknown → long-lived", () => {
    expect(isOneShotCommand("pnpm test")).toBe(true);
    expect(isOneShotCommand("pnpm build")).toBe(true);
    expect(isOneShotCommand("pnpm dev")).toBe(false);
    expect(isOneShotCommand("vitest --watch")).toBe(false); // watch beats test
    expect(isOneShotCommand("pnpm storybook")).toBe(false);
    expect(isOneShotCommand("./mystery.sh")).toBe(false); // unknown → no verdict
  });

  it("an explicit one_shot flag overrides the heuristic", () => {
    expect(
      runActionOneShot({ id: "d", name: "D", command: "pnpm dev", oneShot: true }),
    ).toBe(true);
    expect(
      runActionOneShot({ id: "t", name: "T", command: "pnpm test", oneShot: false }),
    ).toBe(false);
    expect(runActionOneShot({ id: "t", name: "T", command: "pnpm test" })).toBe(
      true,
    );
  });
});

describe("filterRunActionsForPlatform", () => {
  const actions = parseRunActions({
    run_actions: [
      { id: "mac", name: "Mac", command: "m", platforms: ["mac"], default: true },
      { id: "all", name: "All", command: "a" },
      { id: "win", name: "Win", command: "w", platforms: ["win"] },
    ],
  });

  it("keeps platformless actions everywhere and re-normalizes the default", () => {
    const onWin = filterRunActionsForPlatform(actions, "win");
    expect(onWin.map((a) => a.id)).toEqual(["all", "win"]);
    // The mac-only default was filtered out → the first eligible becomes it.
    expect(onWin[0]!.isDefault).toBe(true);
  });

  it("null platform = no filtering", () => {
    expect(filterRunActionsForPlatform(actions, null)).toHaveLength(3);
  });
});