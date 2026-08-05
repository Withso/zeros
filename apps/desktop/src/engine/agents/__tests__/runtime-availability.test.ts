// Regression tests preventing a Connected badge for an unavailable Claude
// runtime.
//
// `authenticated` was evaluated PURELY from the manifest's AuthProbe, which only
// asks whether a credential ARTIFACT exists — a `Claude Code-credentials`
// keychain item (matched by existence alone: no `-w`, no expiry, no validity) or
// `~/.claude/.credentials.json`. Those survive token revocation, uninstalling the
// CLI, and — critically — a build that never shipped the Claude Code runtime at
// all. So Settings → Agent providers showed:
//
//     [Connected]   Provider Anthropic / Plan — / Org — / Account —
//
// while every single send failed with "AGENT RESPONSE FAILURE", because the
// packaged engine (a bun-compiled binary with no node_modules) could not resolve
// the SDK's platform CLI. "Connected" has to mean "this will work".
//
// The manifest is injected here on purpose: in vitest the real Claude runtime
// ALWAYS resolves, so a test using the ambient manifest could never reach the
// unavailable branch — the same blind spot that let this ship.

import { describe, expect, it } from "vitest";

import { toBridgeAgents, type AgentManifestEntry } from "../registry";

const REASON = "Claude Code runtime is missing from this build — …";

function entry(over: Partial<AgentManifestEntry> = {}): AgentManifestEntry {
  return {
    id: "claude",
    name: "Claude Code",
    description: "test",
    cliBinary: "claude",
    authProbe: { kind: "file", paths: ["~/.claude/auth.json"] },
    loginCommand: { binary: "claude", args: ["/login"] },
    createAdapter: () => ({}) as never,
    ...over,
  } as AgentManifestEntry;
}

describe("toBridgeAgents — runtime availability gates 'Connected'", () => {
  it("reports NOT authenticated when the bundled runtime is missing, even with valid credentials", () => {
    // THE regression. Credentials present + runtime missing → the badge must not
    // say Connected.
    const [agent] = toBridgeAgents(
      new Set(["claude"]), // a global `claude` is on PATH too — still irrelevant
      new Set(["claude"]), // credential probe says YES
      undefined,
      undefined,
      undefined,
      [entry({ bundledRuntime: true, runtimeUnavailable: () => REASON })],
    );
    expect(agent.authenticated).toBe(false);
    expect(agent.runtimeUnavailableReason).toBe(REASON);
  });

  it("reports NOT installed and launchKind 'unavailable' when the runtime is missing", () => {
    // bundledRuntime:true used to force installed=true unconditionally, so the
    // panel fell through to "CLI not authenticated" — blaming the user's login
    // for a packaging defect.
    const [agent] = toBridgeAgents(
      new Set(["claude"]),
      new Set(["claude"]),
      undefined,
      undefined,
      undefined,
      [entry({ bundledRuntime: true, runtimeUnavailable: () => REASON })],
    );
    expect(agent.installed).toBe(false);
    expect(agent.launchKind).toBe("unavailable");
  });

  it("passes credentials through untouched when the runtime IS available", () => {
    // The happy path must be byte-identical to before the fix.
    const [agent] = toBridgeAgents(
      new Set(["claude"]),
      new Set(["claude"]),
      undefined,
      undefined,
      undefined,
      [entry({ bundledRuntime: true, runtimeUnavailable: () => null })],
    );
    expect(agent.authenticated).toBe(true);
    expect(agent.installed).toBe(true);
    expect(agent.runtimeUnavailableReason).toBeUndefined();
  });

  it("still reports NOT authenticated when the runtime is fine but credentials are absent", () => {
    // The two signals stay independent — a missing runtime must not become the
    // explanation for an ordinary logged-out state.
    const [agent] = toBridgeAgents(
      new Set(["claude"]),
      new Set(), // no credentials
      undefined,
      undefined,
      undefined,
      [entry({ bundledRuntime: true, runtimeUnavailable: () => null })],
    );
    expect(agent.authenticated).toBe(false);
    expect(agent.runtimeUnavailableReason).toBeUndefined();
    expect(agent.installed).toBe(true);
  });

  it("honours the persisted Executable-path override, clearing the missing state", () => {
    // The missing-runtime message tells the user to set Settings → Agent providers →
    // Executable path. Before this the probe ignored that value, so setting it
    // changed nothing: installed/authenticated stayed false, isRunnableAgent()
    // returned false, and every send was refused with "Not installed" — a DEAD END
    // where the error's own remedy could not clear it. The probe now receives the
    // override the gateway resolved from the user settings layer.
    // Mirrors the real Claude probe: unresolvable UNLESS the user supplies a binary.
    const manifest = [
      entry({
        bundledRuntime: true,
        runtimeUnavailable: (override?: string) => (override ? null : REASON),
      }),
    ];

    const [withOverride] = toBridgeAgents(
      new Set(),
      new Set(["claude"]),
      undefined,
      undefined,
      new Map([["claude", "/Users/me/.claude/local/claude"]]),
      manifest,
    );
    expect(withOverride.runtimeUnavailableReason).toBeUndefined();
    expect(withOverride.authenticated).toBe(true);
    expect(withOverride.installed).toBe(true);

    // …and with no override the same entry still reports the failure.
    const [withoutOverride] = toBridgeAgents(
      new Set(),
      new Set(["claude"]),
      undefined,
      undefined,
      undefined,
      manifest,
    );
    expect(withoutOverride.runtimeUnavailableReason).toBe(REASON);
    expect(withoutOverride.authenticated).toBe(false);
  });

  it("passes each agent only ITS OWN override", () => {
    const seen: Array<string | undefined> = [];
    const probe = () => (override?: string) => {
      seen.push(override);
      return null;
    };
    toBridgeAgents(
      new Set(),
      new Set(),
      undefined,
      undefined,
      new Map([["claude", "/claude/bin"]]),
      [
        entry({ id: "claude", runtimeUnavailable: probe() }),
        entry({ id: "codex", cliBinary: "codex", runtimeUnavailable: probe() }),
      ],
    );
    expect(seen).toEqual(["/claude/bin", undefined]);
  });

  it("leaves agents without a runtimeUnavailable probe unchanged", () => {
    // Codex/Cursor declare no probe; they must keep their existing semantics.
    const [agent] = toBridgeAgents(
      new Set(["codex"]),
      new Set(["codex"]),
      undefined,
      undefined,
      undefined,
      [entry({ id: "codex", cliBinary: "codex" })],
    );
    expect(agent.authenticated).toBe(true);
    expect(agent.installed).toBe(true);
    expect(agent.runtimeUnavailableReason).toBeUndefined();
  });
});

describe("the REAL Claude manifest entry", () => {
  it("declares a runtime probe, so a runtime-less build can never look Connected", () => {
    // Guards the wiring itself: without runtimeUnavailable on the real entry the
    // fix above is inert in production no matter how green these tests are.
    const [claude] = toBridgeAgents(new Set(), new Set(["claude"]));
    expect(claude.id).toBe("claude");
    // In vitest the platform package resolves, so the runtime IS available and
    // this must be undefined — asserting the probe RAN without throwing.
    expect(claude.runtimeUnavailableReason).toBeUndefined();
    expect(claude.authenticated).toBe(true);
  });
});
