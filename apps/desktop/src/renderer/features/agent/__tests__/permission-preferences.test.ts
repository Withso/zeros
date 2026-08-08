import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_PERMISSION_PREFERENCES,
  getPermissionPreference,
  replacePermissionPreferences,
  resolvePermissionConfiguration,
  serializePermissionPreferences,
  setPermissionPreference,
} from "../permission-preferences";

function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("per-agent permission preferences", () => {
  beforeEach(installLocalStorage);
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("uses the product defaults for every native agent family", () => {
    expect(resolvePermissionConfiguration("claude")).toEqual({
      modeId: "auto",
      permissionMode: "auto",
    });
    expect(resolvePermissionConfiguration("codex")).toEqual({
      modeId: "auto-edit",
      permissionMode: "auto",
    });
    expect(resolvePermissionConfiguration("cursor")).toEqual({
      modeId: "auto",
      permissionMode: "auto",
    });
  });

  it("remembers the exact native id independently across agents", () => {
    setPermissionPreference("claude", "accept-edits");
    setPermissionPreference("codex", "full-access");
    setPermissionPreference("cursor", "plan");

    // Claude accept-edits and auto share a coarse posture, so the exact id is
    // load-bearing: a posture-only cache would silently restore the wrong mode.
    expect(resolvePermissionConfiguration("claude")).toEqual({
      modeId: "accept-edits",
      permissionMode: "auto",
    });
    expect(resolvePermissionConfiguration("codex")).toEqual({
      modeId: "full-access",
      permissionMode: "danger",
    });
    expect(resolvePermissionConfiguration("cursor")).toEqual({
      modeId: "plan",
      permissionMode: "plan",
    });
  });

  it("drops malformed rows, deduplicates last-write-wins, and falls back from stale modes", () => {
    replacePermissionPreferences([
      { agent: "codex", mode: "ask" },
      { agent: "", mode: "auto" },
      { agent: "claude", mode: 42 },
      { agent: "codex", mode: "full-access" },
      { agent: "cursor", mode: "retired-mode" },
    ]);

    expect(getPermissionPreference("codex")).toBe("full-access");
    expect(serializePermissionPreferences()).toEqual([
      { agent: "codex", mode: "full-access" },
      { agent: "cursor", mode: "retired-mode" },
    ]);
    expect(resolvePermissionConfiguration("cursor")).toEqual({
      modeId: "auto",
      permissionMode: "auto",
    });
  });

  it("keeps the most recent bounded tail without cross-agent collisions", () => {
    replacePermissionPreferences(
      Array.from({ length: MAX_PERMISSION_PREFERENCES + 7 }, (_, index) => ({
        agent: `extension-${index}`,
        mode: `mode-${index}`,
      })),
    );

    expect(serializePermissionPreferences()).toHaveLength(
      MAX_PERMISSION_PREFERENCES,
    );
    expect(getPermissionPreference("extension-0")).toBeNull();
    expect(
      getPermissionPreference(`extension-${MAX_PERMISSION_PREFERENCES + 6}`),
    ).toBe(`mode-${MAX_PERMISSION_PREFERENCES + 6}`);
  });
});
