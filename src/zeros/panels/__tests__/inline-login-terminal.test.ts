import { describe, expect, it } from "vitest";

import { buildInlineLoginCommand } from "../inline-login-terminal";

describe("inline login command", () => {
  it("replaces the login shell so terminal exit immediately reports completion", () => {
    expect(
      buildInlineLoginCommand("/opt/homebrew/bin/gh", ["auth", "login"]),
    ).toBe("exec /opt/homebrew/bin/gh auth login");
  });

  it("shell-quotes the executable and every argument", () => {
    expect(
      buildInlineLoginCommand("/Applications/Git Hub/bin/gh", [
        "auth",
        "login",
        "--hostname",
        "github.example.test; echo unsafe",
        "it's-valid",
      ]),
    ).toBe(
      "exec '/Applications/Git Hub/bin/gh' auth login --hostname " +
        "'github.example.test; echo unsafe' 'it'\\''s-valid'",
    );
  });

  it("can remove inherited token overrides before interactive login", () => {
    expect(
      buildInlineLoginCommand(
        "/opt/homebrew/bin/gh",
        ["auth", "login", "--hostname", "github.com"],
        ["GH_TOKEN", "GITHUB_TOKEN"],
      ),
    ).toBe(
      "exec /usr/bin/env -u GH_TOKEN -u GITHUB_TOKEN " +
        "/opt/homebrew/bin/gh auth login --hostname github.com",
    );
  });

  it("rejects an environment name that could become an env option", () => {
    expect(() =>
      buildInlineLoginCommand("/opt/homebrew/bin/gh", ["auth", "login"], [
        "--unset=PATH",
      ]),
    ).toThrow(/invalid environment variable name/i);
  });
});
