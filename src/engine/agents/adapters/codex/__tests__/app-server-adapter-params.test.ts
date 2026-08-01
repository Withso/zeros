// Wire-format regression guard for the codex app-server mode mapping.
//
// The two sandbox surfaces:
//   - `thread/start.sandbox` is a SandboxMode — a plain kebab-case
//     string (`"workspace-write"` / `"read-only"` / `"danger-full-access"`).
//   - `turn/start.sandboxPolicy` is a SandboxPolicy — an internally-
//     tagged map with camelCase variant names AND camelCase field
//     names (`{ "type": "workspaceWrite", "writableRoots": [...], ...}`).
// `modePolicyFor` returns BOTH so the adapter can feed each call site.
//
// The types live in `../app-server.ts`, which re-exports from
// `../generated/v2/*` — the latter is regenerated from upstream
// openai/codex on every build (see scripts/codegen-codex.mjs). If
// Codex bumps the protocol and these tests break, regenerate via
// `pnpm codegen:codex` first, then update the assertions to match
// the new shape — DON'T edit the wire format by hand.

import { describe, expect, it } from "vitest";

import {
  buildThreadStartParams,
  fileChangePaths,
  modePolicyFor,
  type CodexModeId,
} from "../app-server-adapter";

const MODES: CodexModeId[] = ["ask", "auto-edit", "full-access", "read-only"];

describe("modePolicyFor", () => {
  it("returns both sandboxMode (thread/start) and sandboxPolicy (turn/start)", () => {
    for (const mode of MODES) {
      const policy = modePolicyFor(mode);
      expect(policy).toHaveProperty("sandboxMode");
      expect(policy).toHaveProperty("sandboxPolicy");
      expect(policy.approvalPolicy).toBeDefined();
    }
  });

  it("emits kebab-case SandboxMode strings", () => {
    expect(modePolicyFor("ask").sandboxMode).toBe("workspace-write");
    expect(modePolicyFor("auto-edit").sandboxMode).toBe("workspace-write");
    expect(modePolicyFor("read-only").sandboxMode).toBe("read-only");
    expect(modePolicyFor("full-access").sandboxMode).toBe("danger-full-access");
  });

  it("emits internally-tagged SandboxPolicy with camelCase type + camelCase fields", () => {
    // v2/permissions.rs uses `#[serde(tag = "type", rename_all = "camelCase")]`.
    // Sending kebab-case here triggers `turn/start: Invalid request:
    // unknown variant 'workspace-write', expected one of
    // 'dangerFullAccess', 'readOnly', 'externalSandbox', 'workspaceWrite'`.
    const ask = modePolicyFor("ask").sandboxPolicy;
    expect(ask.type).toBe("workspaceWrite");
    expect(ask).toHaveProperty("writableRoots");
    expect(ask).toHaveProperty("networkAccess");
    expect(ask).toHaveProperty("excludeTmpdirEnvVar");
    expect(ask).toHaveProperty("excludeSlashTmp");

    expect(modePolicyFor("read-only").sandboxPolicy.type).toBe("readOnly");
    expect(modePolicyFor("full-access").sandboxPolicy.type).toBe("dangerFullAccess");
  });

  it("maps approval policies distinctly per mode and never uses deprecated on-failure", () => {
    // codex deprecated "on-failure" (per-turn warning); "untrusted" is the
    // real ask-before-everything policy, "on-request" the codex-CLI Auto
    // preset. ask and auto-edit must NOT collapse into the same policy.
    expect(modePolicyFor("ask").approvalPolicy).toBe("untrusted");
    expect(modePolicyFor("auto-edit").approvalPolicy).toBe("on-request");
    expect(modePolicyFor("full-access").approvalPolicy).toEqual({
      granular: {
        sandbox_approval: false,
        rules: false,
        skill_approval: false,
        request_permissions: false,
        mcp_elicitations: true,
      },
    });
    for (const mode of MODES) {
      expect(modePolicyFor(mode).approvalPolicy).not.toBe("on-failure");
    }
  });
});

describe("buildThreadStartParams", () => {
  it("emits `sandbox` as a plain string mode (SandboxMode wire format)", () => {
    for (const mode of MODES) {
      const params = buildThreadStartParams("/tmp", undefined, mode);
      expect(params).toHaveProperty("sandbox");
      expect(typeof params.sandbox).toBe("string");
      expect(params).not.toHaveProperty("sandboxPolicy");
      expect(params.cwd).toBe("/tmp");
      expect(params.approvalPolicy).toBeDefined();
    }
  });

  it("includes model only when OPENAI_MODEL env is set", () => {
    expect(buildThreadStartParams("/tmp", undefined, "ask").model).toBeUndefined();
    expect(buildThreadStartParams("/tmp", {}, "ask").model).toBeUndefined();
    expect(
      buildThreadStartParams("/tmp", { OPENAI_MODEL: "gpt-5" }, "ask").model,
    ).toBe("gpt-5");
  });

  // Zeros' first-turn orientation rides the NATIVE instruction channel — and
  // it must be developerInstructions (layers on Codex's built-in system
  // prompt), never baseInstructions (which would REPLACE the whole persona).
  it("maps systemInstruction → developerInstructions, never baseInstructions", () => {
    const params = buildThreadStartParams(
      "/tmp",
      undefined,
      "ask",
      "You are working inside Zeros…",
    );
    expect(params.developerInstructions).toBe("You are working inside Zeros…");
    expect(params).not.toHaveProperty("baseInstructions");
  });

  it("omits developerInstructions when no systemInstruction is given", () => {
    expect(buildThreadStartParams("/tmp", undefined, "ask")).not.toHaveProperty(
      "developerInstructions",
    );
    expect(buildThreadStartParams("/tmp", undefined, "ask", "")).not.toHaveProperty(
      "developerInstructions",
    );
  });
});

describe("fileChangePaths", () => {
  // The adapter caches these off streamed fileChange items so a later
  // approval (whose params carry only the itemId) can show the file count.
  it("collects every change's path, preserving order", () => {
    expect(
      fileChangePaths({
        type: "fileChange",
        changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      }),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("skips changes with a missing or blank path", () => {
    expect(
      fileChangePaths({
        changes: [{ path: "a.ts" }, {}, { path: "  " }, { path: "b.ts" }],
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("returns [] when changes is absent or not an array", () => {
    expect(fileChangePaths({ type: "fileChange" })).toEqual([]);
    expect(fileChangePaths({ changes: "nope" })).toEqual([]);
    expect(fileChangePaths(null)).toEqual([]);
  });
});
