import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncPersonalPreferences } from "../preferences";
import { opSettingsWrite } from "../ops";
import { sanitizeLayer } from "../schema";

describe("personal app preference ownership", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "zeros-preferences-"));
    process.env.ZEROS_USER_SETTINGS_DIR = root;
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  it("imports existing choices once, with file values winning, and never resurrects deleted preferences", () => {
    opSettingsWrite("user", { preferences: { analytics_opt_out: true } });
    expect(
      syncPersonalPreferences({
        analytics_opt_out: false,
        experimental: { terminalAgents: true },
      }),
    ).toEqual({
      analytics_opt_out: true,
      experimental: { terminalAgents: true },
    });
    syncPersonalPreferences({}, { experimental: null });
    expect(
      syncPersonalPreferences({ experimental: { terminalAgents: true } }),
    ).toEqual({ analytics_opt_out: true });
  });
  it("replaces one preference object without losing another window's unrelated preference", () => {
    syncPersonalPreferences({
      appearance: { mode: "dark", codeThemes: { dark: "old" } },
      analytics_opt_out: true,
    });
    expect(
      syncPersonalPreferences(
        {},
        { appearance: { mode: "light", codeThemes: {} } },
      ),
    ).toEqual({
      appearance: { mode: "light", codeThemes: {} },
      analytics_opt_out: true,
    });
  });
  it("rejects malformed changes without rewriting the durable file", () => {
    syncPersonalPreferences({ analytics_opt_out: true });
    const before = readFileSync(path.join(root, "settings.toml"), "utf8");
    expect(() =>
      syncPersonalPreferences({}, { analytics_opt_out: "yes" }),
    ).toThrow();
    expect(readFileSync(path.join(root, "settings.toml"), "utf8")).toBe(before);
    for (const layer of [
      "repo",
      "repo-local",
      "workspace-local",
      "team",
    ] as const)
      expect(
        sanitizeLayer({ preferences: { analytics_opt_out: false } }, layer).doc,
      ).toEqual({});
  });
});
