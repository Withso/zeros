import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../platform/settings", () => ({
  getSetting: (key: string, fallback: unknown) => values.get(key) ?? fallback,
  setSetting: (key: string, value: unknown) => values.set(key, value),
}));
import {
  readScopedSettingsSelection,
  writeScopedSettingsSelection,
  pruneScopedSettingsSelections,
  settingsOwnerKey,
} from "../settings-scope";

beforeEach(() => values.clear());
describe("settings ownership", () => {
  it("keeps the legacy Local selection while restoring A → B → A synchronously", () => {
    values.set("settings:active-section", "user:appearance");
    const a = settingsOwnerKey("member", "org-a"),
      b = settingsOwnerKey("member", "org-b");
    expect(readScopedSettingsSelection(a, "section", "user:providers")).toBe(
      "user:providers",
    );
    writeScopedSettingsSelection(a, "section", "user:integrations");
    writeScopedSettingsSelection(b, "section", "user:cloud-computer");
    expect(readScopedSettingsSelection(a, "section", "fallback")).toBe(
      "user:integrations",
    );
    expect(readScopedSettingsSelection(b, "section", "fallback")).toBe(
      "user:cloud-computer",
    );
    expect(readScopedSettingsSelection("local", "section", "fallback")).toBe(
      "user:appearance",
    );
    expect(
      readScopedSettingsSelection(
        settingsOwnerKey("another-member", "org-a"),
        "section",
        "fallback",
      ),
    ).toBe("fallback");
  });
  it("isolates provider selection and prunes only an authoritative account's removed owners", () => {
    const a = settingsOwnerKey("member", "org-a"),
      b = settingsOwnerKey("member", "org-b");
    const other = settingsOwnerKey("other", "org-b");
    for (const owner of [a, b, other, "local"])
      writeScopedSettingsSelection(owner, "provider", "codex");
    pruneScopedSettingsSelections("member", ["org-b"]);
    expect(readScopedSettingsSelection(a, "provider", "claude")).toBe("claude");
    for (const owner of [b, other, "local"])
      expect(readScopedSettingsSelection(owner, "provider", "claude")).toBe(
        "codex",
      );
  });
  it("bounds retained owners without evicting Local", () => {
    writeScopedSettingsSelection("local", "section", "user:general");
    for (let i = 0; i < 80; i++)
      writeScopedSettingsSelection(
        settingsOwnerKey("member", `org-${i}`),
        "provider",
        "cursor",
      );
    expect(
      readScopedSettingsSelection(
        settingsOwnerKey("member", "org-0"),
        "provider",
        "claude",
      ),
    ).toBe("claude");
    expect(
      readScopedSettingsSelection(
        settingsOwnerKey("member", "org-79"),
        "provider",
        "claude",
      ),
    ).toBe("cursor");
    expect(readScopedSettingsSelection("local", "section", "fallback")).toBe(
      "user:general",
    );
  });
  it("ignores malformed persistence without executing inherited keys", () => {
    values.set("settings:organization-selections:v1", {
      __proto__: { section: "user:environment" },
      broken: 1,
    });
    expect(readScopedSettingsSelection("__proto__", "section", "safe")).toBe(
      "safe",
    );
    expect(() =>
      writeScopedSettingsSelection(
        settingsOwnerKey("member", "org"),
        "section",
        "user:providers",
      ),
    ).not.toThrow();
  });
});
