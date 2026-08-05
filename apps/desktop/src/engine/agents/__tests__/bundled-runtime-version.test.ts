// Guards the bundled-runtime version path (registry.bundledRuntimeVersion + the
// gateway's listAgents short-circuit). Claude + Codex run a CLI shipped INSIDE
// the app — the Agent SDK's pinned claude-code and the @openai/codex dep — so
// their reported "installed version" must come from the bundled package manifest,
// NOT the user's global `<cli> --version` (which only matters for sign-in via
// Terminal). Agents whose runtime IS the user's global CLI return null, which is
// what makes the gateway fall through to probeCliCompatibility instead of
// short-circuiting. Regressions here silently mis-report the Providers UI +
// version-compat signal, so pin the contract.

import { describe, expect, it } from "vitest";

import { bundledRuntimeVersion } from "../registry";

const SEMVER = /^\d+\.\d+\.\d+/;

describe("bundledRuntimeVersion", () => {
  it("reports the bundled CLI semver for Claude (the Agent SDK's pinned claude-code)", () => {
    const v = bundledRuntimeVersion("claude");
    expect(v).not.toBeNull();
    expect(v).toMatch(SEMVER);
  });

  it("reports the bundled CLI semver for Codex (the @openai/codex dep)", () => {
    const v = bundledRuntimeVersion("codex");
    expect(v).not.toBeNull();
    expect(v).toMatch(SEMVER);
  });

  it("returns null for cursor (no bundled-CLI version source)", () => {
    // The @cursor/sdk ships its own runtime; bundledRuntimeVersion has no
    // `case "cursor"`, so the gateway falls through to the PATH `--version`
    // probe for the displayed version rather than a bundled one.
    expect(bundledRuntimeVersion("cursor")).toBeNull();
  });

  it("returns null for an unknown agent id", () => {
    expect(bundledRuntimeVersion("definitely-not-an-agent")).toBeNull();
  });
});
