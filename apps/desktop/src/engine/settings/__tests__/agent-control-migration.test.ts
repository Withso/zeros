import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  migrateRetiredAgentControlSettings,
  retiredAgentControlPatch,
} from "../agent-control-migration";
import { opSettingsRead, opSettingsResolve, opSettingsWrite } from "../ops";

describe("retiring browser and computer-use switches without a Settings row", () => {
  it("removes every retired key and leaves a clean file alone", () => {
    expect(retiredAgentControlPatch({})).toBeNull();
    expect(
      retiredAgentControlPatch({
        browser: { enabled: true, claude_enabled: true, auto_open: false },
        computer_use: { enabled: false, show_agent_cursor: true, blocked_apps: [] },
      }),
    ).toBeNull();
    expect(
      retiredAgentControlPatch({
        browser: {
          codex_enabled: true,
          in_app_enabled: true,
          codex_native: true,
          provider: "isolated",
          show_agent_cursor: true,
          navigation_approval: "always-ask",
        },
        computer_use: { app_access: "ask", codex_native: true },
      }),
    ).toEqual({
      browser: {
        codex_enabled: null,
        in_app_enabled: null,
        codex_native: null,
        provider: null,
        show_agent_cursor: null,
        navigation_approval: null,
      },
      computer_use: { app_access: null, codex_native: null },
    });
  });

  it("never turns an opt-out into access", () => {
    // Browser use any agent was denied stays off for every agent.
    for (const browser of [{ codex_enabled: false }, { in_app_enabled: false }]) {
      expect(retiredAgentControlPatch({ browser: { enabled: true, ...browser } })?.browser).toMatchObject({
        enabled: false,
      });
    }
    // A hidden browser pointer stays hidden under the shared cursor switch.
    expect(retiredAgentControlPatch({ browser: { show_agent_cursor: false } })).toEqual({
      browser: { show_agent_cursor: null },
      computer_use: { show_agent_cursor: false },
    });
    // Turned-on switches change nothing beyond their removal.
    expect(retiredAgentControlPatch({ browser: { codex_enabled: true, in_app_enabled: true } })).toEqual({
      browser: { codex_enabled: null, in_app_enabled: null },
    });
  });
});

describe("migrateRetiredAgentControlSettings", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "zeros-agent-control-migration-"));
    process.env.ZEROS_USER_SETTINGS_DIR = root;
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("folds the old keys once and keeps every other setting", () => {
    const file = path.join(root, "settings.toml");
    writeFileSync(
      file,
      [
        "[git]",
        "base_branch = \"develop\"",
        "",
        "[browser]",
        "codex_enabled = false",
        "codex_native = true",
        "navigation_approval = \"always-ask\"",
        "auto_open = false",
        "",
        "[computer_use]",
        "app_access = \"ask\"",
        "blocked_apps = [\"com.apple.Notes\"]",
        "",
      ].join("\n"),
    );
    expect(migrateRetiredAgentControlSettings()).toBe(true);
    // The same format-preserving writer as every Settings change.
    const text = readFileSync(file, "utf8");
    for (const key of ["codex_enabled", "codex_native", "navigation_approval", "app_access"]) {
      expect(text).not.toContain(key);
    }
    expect(opSettingsRead("user").doc).toMatchObject({
      git: { base_branch: "develop" },
      browser: { enabled: false, auto_open: false },
      computer_use: { blocked_apps: ["com.apple.Notes"] },
    });
    expect(opSettingsRead("user").doc.browser).toEqual({ enabled: false, auto_open: false });
    expect(opSettingsRead("user").doc.computer_use).toEqual({ blocked_apps: ["com.apple.Notes"] });
    // Resolution no longer warns about keys nobody can see in Settings.
    expect(opSettingsResolve(root).warnings).toEqual([]);
    // Idempotent: nothing left to retire.
    expect(migrateRetiredAgentControlSettings()).toBe(false);
  });

  it("lets a Settings change win over a retired key that came back mid-session", () => {
    const file = path.join(root, "settings.toml");
    writeFileSync(file, "[browser]\nin_app_enabled = false\n\n[computer_use]\napp_access = \"ask\"\n");
    // Read folds the opt-out, so Settings shows browser use off...
    expect(opSettingsResolve(root).effective.browser).toMatchObject({ enabled: false });
    // ...and turning it on sticks instead of bouncing back.
    opSettingsWrite("user", { browser: { enabled: true } });
    expect(opSettingsRead("user").doc.browser).toEqual({ enabled: true });
    expect(opSettingsRead("user").doc).not.toHaveProperty("computer_use");
    expect(opSettingsResolve(root).effective.browser).toMatchObject({ enabled: true });

    // A change elsewhere keeps the folded opt-out and drops the retired key.
    writeFileSync(file, "[browser]\nshow_agent_cursor = false\ncodex_enabled = false\n");
    opSettingsWrite("user", { git: { base_branch: "develop" } });
    expect(opSettingsRead("user").doc).toMatchObject({
      browser: { enabled: false },
      computer_use: { show_agent_cursor: false },
      git: { base_branch: "develop" },
    });
    expect(opSettingsRead("user").doc.browser).toEqual({ enabled: false });
  });

  it("leaves a missing or malformed file alone", () => {
    expect(migrateRetiredAgentControlSettings()).toBe(false);
    const file = path.join(root, "settings.toml");
    writeFileSync(file, "[browser\ncodex_native = true\n");
    expect(migrateRetiredAgentControlSettings()).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("[browser\ncodex_native = true\n");
  });
});
