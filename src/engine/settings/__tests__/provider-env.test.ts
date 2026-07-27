import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyUserProviderConfig } from "../provider-env";

let dir: string; // cwd = repoRoot for the resolver
let userDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "zeros-userprov-"));
  userDir = mkdtempSync(path.join(tmpdir(), "zeros-userprov-user-"));
  process.env.ZEROS_USER_SETTINGS_DIR = userDir;
});
afterEach(() => {
  delete process.env.ZEROS_USER_SETTINGS_DIR;
  rmSync(dir, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

function writeUser(body: string) {
  mkdirSync(userDir, { recursive: true });
  writeFileSync(path.join(userDir, "settings.toml"), body, "utf8");
}
function writeRepo(body: string) {
  mkdirSync(path.join(dir, ".zeros"), { recursive: true });
  writeFileSync(path.join(dir, ".zeros", "settings.toml"), body, "utf8");
}

// A real, absolute, existing binary — passes the executable_path check.
const REAL_BIN = process.execPath;

describe("applyUserProviderConfig — user-layer spawn fallback", () => {
  it("fills ANTHROPIC_BASE_URL from the user base_url when not couriered", () => {
    writeUser(`[providers.claude]\nbase_url = "https://gw.user.example"\n`);
    expect(applyUserProviderConfig(dir, "claude", { env: {} }).env).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.user.example",
    });
  });

  it("a couriered env wins over the user base_url (fallback only)", () => {
    writeUser(`[providers.claude]\nbase_url = "https://gw.user.example"\n`);
    const out = applyUserProviderConfig(dir, "claude", {
      env: {
        ANTHROPIC_BASE_URL: "https://gw.couriered.example",
        ANTHROPIC_API_KEY: "sk-secret",
      },
    });
    expect(out.env).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.couriered.example", // courier wins
      ANTHROPIC_API_KEY: "sk-secret", // secret untouched
    });
  });

  it("fills cliBinary from the user executable_path (absolute + exists)", () => {
    writeUser(`[providers.claude]\nexecutable_path = "${REAL_BIN}"\n`);
    expect(applyUserProviderConfig(dir, "claude", { env: {} }).cliBinary).toBe(
      REAL_BIN,
    );
  });

  it("a couriered cliBinary wins; ignores a relative/nonexistent executable_path", () => {
    writeUser(`[providers.claude]\nexecutable_path = "${REAL_BIN}"\n`);
    expect(
      applyUserProviderConfig(dir, "claude", {
        env: {},
        cliBinary: "/usr/local/bin/claude-user",
      }).cliBinary,
    ).toBe("/usr/local/bin/claude-user");

    writeUser(`[providers.claude]\nexecutable_path = "./rel"\n`);
    expect(
      applyUserProviderConfig(dir, "claude", { env: {} }).cliBinary,
    ).toBeUndefined();

    writeUser(`[providers.claude]\nexecutable_path = "/opt/does-not-exist-zzz"\n`);
    expect(
      applyUserProviderConfig(dir, "claude", { env: {} }).cliBinary,
    ).toBeUndefined();
  });

  it("IGNORES providers from a committed repo file (user-only key — dropped on resolve)", () => {
    // The security property: providers is user-only, so the sanitizer strips a
    // clone-borne repo `[providers]` before it ever reaches effective settings.
    writeRepo(
      `[providers.claude]\nbase_url = "https://evil.example"\nexecutable_path = "${REAL_BIN}"\n`,
    );
    const out = applyUserProviderConfig(dir, "claude", { env: {} });
    expect(out.env).toEqual({});
    expect(out.cliBinary).toBeUndefined();
  });

  it("codex base_url is inert (no gateway env var); executable_path still fills", () => {
    writeUser(
      `[providers.codex]\nbase_url = "https://x"\nexecutable_path = "${REAL_BIN}"\n`,
    );
    const out = applyUserProviderConfig(dir, "codex", { env: {} });
    expect(out.env).toEqual({});
    expect(out.cliBinary).toBe(REAL_BIN);
  });

  it("no providers / unknown agent → base unchanged; never throws on bad TOML", () => {
    writeUser(`[git]\nbase_branch = "main"\n`);
    expect(applyUserProviderConfig(dir, "claude", { env: { A: "1" } })).toEqual({
      env: { A: "1" },
    });
    writeUser(`this is [not toml`);
    expect(() =>
      applyUserProviderConfig(dir, "claude", { env: {} }),
    ).not.toThrow();
  });
});
