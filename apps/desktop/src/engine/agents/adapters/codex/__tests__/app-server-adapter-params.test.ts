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

import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentFilesystemTerritory } from "../../../types";

import {
  buildThreadStartParams,
  codexTurnAuthority,
  codexEffortFromThreadSettings,
  fileChangePaths,
  mapCodexAdvertisedEffort,
  mapCodexEffortFromEnv,
  modePolicyFor,
  territoryApprovalMustBeDenied,
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
    expect(modePolicyFor("full-access").sandboxPolicy.type).toBe(
      "dangerFullAccess",
    );
  });

  it("maps approval policies distinctly per mode and never uses deprecated on-failure", () => {
    // codex deprecated "on-failure" (per-turn warning); "untrusted" is the
    // real ask-before-everything policy, "on-request" the codex-CLI Auto
    // preset. ask and auto-edit must NOT collapse into the same policy.
    expect(modePolicyFor("ask").approvalPolicy).toBe("untrusted");
    expect(modePolicyFor("auto-edit").approvalPolicy).toBe("on-request");
    expect(modePolicyFor("full-access").approvalPolicy).toBe("never");
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
    expect(
      buildThreadStartParams("/tmp", undefined, "ask").model,
    ).toBeUndefined();
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
    expect(
      buildThreadStartParams("/tmp", undefined, "ask", ""),
    ).not.toHaveProperty("developerInstructions");
  });

  it.each(MODES)(
    "keeps the immutable territory profile in the %s permission posture",
    (mode) => {
      const workspaceRoot = path.resolve("/tmp/zeros-contained");
      const designDirectory = path.join(workspaceRoot, "Zeros Design");
      const territory: AgentFilesystemTerritory = {
        agentRole: "code",
        workspaceRoot,
        designDirectory,
        protectedDesignDirectories: [designDirectory],
        writeCapabilities: {
          workspace: "write",
          deniedPaths: [
            designDirectory,
            path.join(workspaceRoot, ".zeros"),
            path.join(workspaceRoot, ".git"),
          ],
        },
      };

      const params = buildThreadStartParams(
        workspaceRoot,
        undefined,
        mode,
        undefined,
        territory,
      );

      expect(params).not.toHaveProperty("sandbox");
      expect(params.permissions).toBe("zeros_code_territory");
      expect(params.runtimeWorkspaceRoots).toEqual([workspaceRoot]);
      expect(params.config).toMatchObject({
        permissions: {
          zeros_code_territory: {
            workspace_roots: { [workspaceRoot]: true },
            filesystem: {
              ":minimal": "read",
              ":workspace_roots": "write",
              [designDirectory]: "read",
              [path.join(workspaceRoot, ".zeros")]: "read",
              [path.join(workspaceRoot, ".git")]: "read",
            },
          },
        },
      });
    },
  );
});

describe("uniform ZSR turn authority", () => {
  const workspaceRoot = path.resolve("/tmp/zeros-contained-turn");
  const designDirectory = path.join(workspaceRoot, "Zeros Design");
  const territory: AgentFilesystemTerritory = {
    agentRole: "code",
    workspaceRoot,
    designDirectory,
    protectedDesignDirectories: [designDirectory],
    writeCapabilities: {
      workspace: "write",
      deniedPaths: [designDirectory],
    },
  };

  it.each(MODES)(
    "keeps the normal %s per-turn sandbox inside the outer ZSR boundary",
    (mode) => {
      const sandboxPolicy = modePolicyFor(mode).sandboxPolicy;

      expect(
        codexTurnAuthority(territory, {} as never, sandboxPolicy),
      ).toEqual({ sandboxPolicy });
      expect(
        codexTurnAuthority(territory, undefined, sandboxPolicy),
      ).toEqual({
        permissions: "zeros_code_territory",
        runtimeWorkspaceRoots: [workspaceRoot],
      });
    },
  );

  it("does not suppress ordinary approvals that remain kernel-bounded by ZSR", () => {
    const session = {
      territory,
      executionBoundary: {} as never,
      fileEditPathsByItemId: new Map(),
    };

    expect(
      territoryApprovalMustBeDenied(session, {
        method: "execCommandApproval",
        params: { command: "pnpm test" },
      } as never),
    ).toBe(false);
    expect(
      territoryApprovalMustBeDenied(session, {
        method: "item/fileChange/requestApproval",
        params: { grantRoot: designDirectory },
      } as never),
    ).toBe(true);
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

describe("Codex Ultra effort synchronization", () => {
  it("sends the composer Ultra value as Codex's native ultra effort", () => {
    expect(mapCodexEffortFromEnv("ultracode")).toBe("ultra");
  });

  it("preserves Codex's native max tier exactly", () => {
    // GPT-5.6 advertises and accepts `max`. Downgrading it to `xhigh` makes the
    // provider's thread/settings update overwrite the user's Max selection in
    // the composer with Extra High after the first send.
    expect(mapCodexEffortFromEnv("max")).toBe("max");
    expect(mapCodexEffortFromEnv("MAX ")).toBe("max");
  });

  it("passes the tiers Codex really has through verbatim", () => {
    expect(mapCodexEffortFromEnv("minimal")).toBe("minimal");
    expect(mapCodexEffortFromEnv("low")).toBe("low");
    expect(mapCodexEffortFromEnv("medium")).toBe("medium");
    expect(mapCodexEffortFromEnv("high")).toBe("high");
    expect(mapCodexEffortFromEnv("xhigh")).toBe("xhigh");
    expect(mapCodexEffortFromEnv("ultra")).toBe("ultra");
    // Unknown / empty stays unset so Codex picks its own default.
    expect(mapCodexEffortFromEnv("turbo")).toBeUndefined();
    expect(mapCodexEffortFromEnv(undefined)).toBeUndefined();
  });

  it("normalizes Codex's advertised ultra tier into the existing composer token", () => {
    expect(mapCodexAdvertisedEffort("ultra")).toBe("ultracode");
    expect(mapCodexAdvertisedEffort("xhigh")).toBe("xhigh");
    expect(mapCodexAdvertisedEffort("minimal")).toBeUndefined();
  });

  it("accepts settings updates only for the exact parent thread", () => {
    const params = {
      threadId: "thread-parent",
      threadSettings: { effort: "ultra" },
    };
    expect(codexEffortFromThreadSettings(params, "thread-parent")).toBe(
      "ultracode",
    );
    expect(codexEffortFromThreadSettings(params, "thread-helper")).toBeNull();
  });
});
