// Regression: renaming a persisted settings key must CARRY THE VALUE FORWARD.
//
// The 2026-07-25 Organization→Team rename moved two persisted keys
// (`org:active-id` → `team:active-id`, `org:has-orgs` → `team:has-teams`).
// Renaming them without a migration doesn't default the value — it loses it,
// and neither reader can tell "never set" from "set under the old name":
//
//   • active-id: no selection → the store falls back to teams[0], and
//     team-sync couriers THAT team's settings doc into the engine. A
//     multi-team user silently spawns agents under the wrong team's [env]
//     and git baseline (the hardcoded-orgs[0] bug audit fix H2 removed).
//   • has-teams: returns null instead of the persisted answer, so
//     `zeroTeams` computes false while the first /v1/me is in flight and the
//     Administration tabs flash in and vanish — what review L1 fixed.

import { beforeEach, describe, expect, it } from "vitest";

// The suite runs on `environment: "node"`, which has no localStorage, and
// native/settings.ts reads the global at call time — so a minimal in-memory
// stub installed before the import is enough.
const store = new Map<string, string>();
const stub: Storage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = stub;

const { getSettingMigrated, setSetting } = await import("../../../native/settings");


const PREFIX = "zeros-";
const raw = (k: string) => store.get(PREFIX + k) ?? null;

describe("getSettingMigrated", () => {
  beforeEach(() => store.clear());

  it("adopts the legacy value, rewrites it under the new key, and clears the old", () => {
    setSetting("org:active-id", "team-b");

    expect(getSettingMigrated<string | null>("team:active-id", "org:active-id", null)).toBe(
      "team-b",
    );
    expect(raw("team:active-id")).toBe(JSON.stringify("team-b"));
    expect(raw("org:active-id")).toBeNull(); // old slot cleared, not left to rot
  });

  it("is idempotent — a second read returns the same value with the legacy key gone", () => {
    setSetting("org:active-id", "team-b");
    getSettingMigrated<string | null>("team:active-id", "org:active-id", null);

    expect(getSettingMigrated<string | null>("team:active-id", "org:active-id", null)).toBe(
      "team-b",
    );
  });

  it("prefers the new key when both exist (a stale legacy value never wins)", () => {
    setSetting("org:active-id", "team-old");
    setSetting("team:active-id", "team-new");

    expect(getSettingMigrated<string | null>("team:active-id", "org:active-id", null)).toBe(
      "team-new",
    );
  });

  it("keeps the legacy value when the copy FAILS — never destroys the only copy", () => {
    // setSetting swallows quota/privacy errors. Removing the legacy key
    // regardless would lose the active-team selection outright, and team-sync
    // would then courier teams[0]'s settings into the engine — the exact
    // wrong-tenant bug this whole helper exists to prevent.
    setSetting("org:active-id", "team-b");
    const realSet = stub.setItem;
    stub.setItem = (k: string) => {
      if (k.startsWith(PREFIX + "team:")) throw new Error("QuotaExceededError");
      realSet.call(stub, k, "");
    };
    try {
      expect(
        getSettingMigrated<string | null>("team:active-id", "org:active-id", null),
      ).toBe("team-b"); // caller still gets the right answer this session
      expect(raw("org:active-id")).toBe(JSON.stringify("team-b")); // and it survives
    } finally {
      stub.setItem = realSet;
    }

    // Next launch, with storage healthy again, the move completes.
    expect(
      getSettingMigrated<string | null>("team:active-id", "org:active-id", null),
    ).toBe("team-b");
    expect(raw("team:active-id")).toBe(JSON.stringify("team-b"));
    expect(raw("org:active-id")).toBeNull();
  });

  it("keeps the legacy value when the write is silently dropped (accepts, stores nothing)", () => {
    setSetting("org:active-id", "team-b");
    const realSet = stub.setItem;
    stub.setItem = (k: string, v: string) => {
      if (k.startsWith(PREFIX + "team:")) return; // no throw, no store
      realSet.call(stub, k, v);
    };
    try {
      expect(
        getSettingMigrated<string | null>("team:active-id", "org:active-id", null),
      ).toBe("team-b");
      expect(raw("org:active-id")).toBe(JSON.stringify("team-b"));
    } finally {
      stub.setItem = realSet;
    }
  });

  it("returns the fallback when neither key is set, without writing anything", () => {
    expect(getSettingMigrated<string | null>("team:active-id", "org:active-id", null)).toBeNull();
    expect(raw("team:active-id")).toBeNull();
  });

  it("carries `false` across — a falsy persisted value is a real answer, not 'unset'", () => {
    // The has-teams hint distinguishes false (zero teams, hide the tabs) from
    // null (unknown, don't gate yet). Collapsing false→null reopens L1.
    setSetting("org:has-orgs", false);

    expect(
      getSettingMigrated<boolean | null>("team:has-teams", "org:has-orgs", null),
    ).toBe(false);
    expect(raw("team:has-teams")).toBe(JSON.stringify(false));
  });
});

// The wiring is the part that actually regressed: getSettingMigrated existing
// but not being CALLED by the readers is the same bug. These pin both call
// sites to the pre-rename key names.
describe("the Team readers adopt their pre-rename keys", () => {
  beforeEach(() => store.clear());

  it("getActiveTeamId() recovers a selection stored as org:active-id", async () => {
    setSetting("org:active-id", "team-b");
    const { getActiveTeamId } = await import("../active-team");
    expect(getActiveTeamId()).toBe("team-b");
  });

  it("lastKnownHasTeams() recovers the gating hint stored as org:has-orgs", async () => {
    setSetting("org:has-orgs", false);
    const { lastKnownHasTeams } = await import("../team-store");
    expect(lastKnownHasTeams()).toBe(false);
  });
});
