// The approval decision mapper is a high-severity safety boundary
// class in the Codex adapter: it turns the user's choice (or the ABSENCE of a
// choice — timeout, no handler, dispose) into the decision codex acts on. A
// refactor here could silently mis-map a Decline into an accept and ship green.
// These lock the whole matrix AND the headline invariant — an unapproved action
// NEVER becomes a grant ("unapproved never runs").
//
// The mapper is pure and respondToPermission forwards its output verbatim to the
// runtime (app-server-adapter.ts: `mapResponseToCodexDecision(...)` →
// `pending.runtime.respondToPermission(id, codexResponse)`), so a decision
// asserted here is exactly what codex receives.

import { describe, it, expect } from "vitest";

import {
  autoEditCanAutoApprove,
  mapApprovalToCanonical,
  mapResponseToCodexDecision,
  defaultMethodResponse,
  type PendingApproval,
} from "../app-server-adapter";
import {
  defaultDenyResponse,
  defaultCancelResponse,
  type CodexApprovalMethod,
} from "../app-server";
import type { RequestPermissionResponse } from "../../../types";

const EXEC: CodexApprovalMethod = "item/commandExecution/requestApproval";
const FILE: CodexApprovalMethod = "item/fileChange/requestApproval";
const PERMS: CodexApprovalMethod = "item/permissions/requestApproval";
const LEGACY_EXEC: CodexApprovalMethod = "execCommandApproval";
const LEGACY_PATCH: CodexApprovalMethod = "applyPatchApproval";
/** The two methods whose decision is a plain string union. */
const RUN_METHODS: CodexApprovalMethod[] = [EXEC, FILE];
const LEGACY_RUN_METHODS: CodexApprovalMethod[] = [LEGACY_EXEC, LEGACY_PATCH];

/** Minimal PendingApproval — the mapper reads only method + params. */
const pending = (
  method: CodexApprovalMethod,
  params: Record<string, unknown> = {},
): PendingApproval => ({ method, params, runtime: {} as never });

const selected = (optionId: string): RequestPermissionResponse =>
  ({ outcome: { outcome: "selected", optionId } }) as RequestPermissionResponse;
const cancelled = (): RequestPermissionResponse =>
  ({ outcome: { outcome: "cancelled" } }) as RequestPermissionResponse;

/** The "granted nothing" permissions payload — network off, no fs access. */
const EMPTY_GRANT = {
  permissions: {
    network: { enabled: false },
    fileSystem: { read: [], write: [] },
  },
  scope: "turn",
};

describe("mapResponseToCodexDecision — command & file-change (4 options × 2 methods)", () => {
  const optionToDecision: Array<[string, string]> = [
    ["accept", "accept"],
    ["acceptForSession", "acceptForSession"],
    ["decline", "decline"],
    ["cancel", "cancel"],
  ];
  for (const method of RUN_METHODS) {
    for (const [optionId, decision] of optionToDecision) {
      it(`${method} · ${optionId} → {decision:"${decision}"}`, () => {
        expect(
          mapResponseToCodexDecision(pending(method), selected(optionId)),
        ).toEqual({ decision });
      });
    }
    it(`${method} · a cancelled outcome → {decision:"cancel"}`, () => {
      expect(mapResponseToCodexDecision(pending(method), cancelled())).toEqual({
        decision: "cancel",
      });
    });
    it(`${method} · an UNKNOWN optionId falls safe to cancel (never runs)`, () => {
      expect(
        mapResponseToCodexDecision(pending(method), selected("nonsense")),
      ).toEqual({ decision: "cancel" });
    });
  }
});

describe("Codex ordered command approval decisions", () => {
  const execAmendment = {
    acceptWithExecpolicyAmendment: {
      execpolicy_amendment: ["git", "status"],
    },
  };
  const networkAmendment = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "api.example.com", action: "allow" },
    },
  };
  const params = {
    itemId: "cmd-1",
    command: "curl https://api.example.com",
    cwd: "/repo",
    reason: "Needs the API",
    networkApprovalContext: { host: "api.example.com", protocol: "https" },
    additionalPermissions: {
      network: { enabled: true },
      fileSystem: { read: ["/repo/input"], write: null },
    },
    proposedExecpolicyAmendment: ["git", "status"],
    proposedNetworkPolicyAmendments: [
      { host: "api.example.com", action: "allow" },
    ],
    availableDecisions: [
      "accept",
      execAmendment,
      networkAmendment,
      "decline",
      "cancel",
    ],
  };

  it("presents every native decision in provider order and preserves escalation context", () => {
    const request = mapApprovalToCanonical(
      {
        zerosSessionId: "s",
        fileEditPathsByItemId: new Map(),
      } as never,
      { permissionId: "p", method: EXEC, params } as never,
    );

    expect(request.useOptionNames).toBe(true);
    expect(
      request.options.map(({ optionId, name, kind }) => ({
        optionId,
        name,
        kind,
      })),
    ).toEqual([
      { optionId: "accept", name: "Approve once", kind: "allow_once" },
      {
        optionId: "acceptWithExecpolicyAmendment:1",
        name: "Approve and remember command rule",
        kind: "allow_always",
      },
      {
        optionId: "applyNetworkPolicyAmendment:2",
        name: "Approve and allow api.example.com",
        kind: "allow_always",
      },
      { optionId: "decline", name: "Decline", kind: "reject_once" },
      { optionId: "cancel", name: "Cancel", kind: "reject_always" },
    ]);
    // Provider-ordered amendments are the reason local policies are off: a
    // tool-title rule could auto-select the wrong one on a later request.
    expect(request.allowLocalPolicies).toBe(false);
    expect(request.contextItems).toEqual([
      "Network · https://api.example.com",
      "Extra network access",
      "Read · /repo/input",
    ]);
    expect(request.toolCall.rawInput).toMatchObject({
      networkApprovalContext: params.networkApprovalContext,
      additionalPermissions: params.additionalPermissions,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
      proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
    });
  });

  it("leaves saved chat policies working on gates that carry no amendments", () => {
    const session = {
      zerosSessionId: "s",
      fileEditPathsByItemId: new Map(),
    } as never;
    // Edit and permission gates have no `availableDecisions`, so the
    // wrong-amendment risk that disables local policies does not exist there —
    // rules a user already saved with "don't ask again" must keep resolving.
    for (const method of [FILE, PERMS, LEGACY_PATCH, LEGACY_EXEC]) {
      const request = mapApprovalToCanonical(session, {
        permissionId: "p",
        method,
        params: { itemId: "item-1" },
      } as never);
      expect(request.useOptionNames).toBeUndefined();
      expect(request.allowLocalPolicies).toBeUndefined();
    }
    // A command gate whose app-server sent no ordered list behaves the same.
    const untyped = mapApprovalToCanonical(session, {
      permissionId: "p",
      method: EXEC,
      params: { itemId: "cmd-1", command: "ls" },
    } as never);
    expect(untyped.allowLocalPolicies).toBeUndefined();
  });

  it("round-trips only the exact offered amendment object", () => {
    expect(
      mapResponseToCodexDecision(
        pending(EXEC, params),
        selected("acceptWithExecpolicyAmendment:1"),
      ),
    ).toEqual({ decision: execAmendment });
    expect(
      mapResponseToCodexDecision(
        pending(EXEC, params),
        selected("applyNetworkPolicyAmendment:2"),
      ),
    ).toEqual({ decision: networkAmendment });
  });

  it("rejects forged, stale, or unavailable decision ids", () => {
    expect(
      mapResponseToCodexDecision(
        pending(EXEC, { availableDecisions: ["decline"] }),
        selected("accept"),
      ),
    ).toEqual({ decision: "cancel" });
    expect(
      mapResponseToCodexDecision(
        pending(EXEC, params),
        selected("acceptWithExecpolicyAmendment:99"),
      ),
    ).toEqual({ decision: "cancel" });
    expect(
      mapResponseToCodexDecision(
        pending(EXEC, params),
        selected("applyNetworkPolicyAmendment:1"),
      ),
    ).toEqual({ decision: "cancel" });
  });

  it("does not silently auto-approve when direct acceptance is not offered", () => {
    expect(
      autoEditCanAutoApprove({
        permissionId: "p",
        method: EXEC,
        params: { availableDecisions: [execAmendment, "decline"] },
      } as never),
    ).toBe(false);
    expect(
      autoEditCanAutoApprove({
        permissionId: "p",
        method: EXEC,
        params: { availableDecisions: ["accept", "decline"] },
      } as never),
    ).toBe(true);
  });
});

describe("mapResponseToCodexDecision — permissions request (mirror-on-accept)", () => {
  const REQUESTED = {
    network: { enabled: true },
    fileSystem: { read: ["/repo/a"], write: ["/repo/b"] },
  };

  it("accept mirrors the agent's requested profile, scope=turn", () => {
    expect(
      mapResponseToCodexDecision(
        pending(PERMS, { permissions: REQUESTED }),
        selected("accept"),
      ),
    ).toEqual({ permissions: REQUESTED, scope: "turn" });
  });

  it("acceptForSession mirrors the profile, scope=session", () => {
    expect(
      mapResponseToCodexDecision(
        pending(PERMS, { permissions: REQUESTED }),
        selected("acceptForSession"),
      ),
    ).toEqual({ permissions: REQUESTED, scope: "session" });
  });

  it("preserves entry-based filesystem grants and nullable permission fields", () => {
    const extended = {
      network: { enabled: null },
      fileSystem: {
        read: null,
        write: ["/repo/output"],
        globScanMaxDepth: 4,
        entries: [
          {
            path: { type: "glob_pattern", pattern: "/repo/data/**" },
            access: "read",
          },
        ],
      },
    };
    expect(
      mapResponseToCodexDecision(
        pending(PERMS, { permissions: extended }),
        selected("accept"),
      ),
    ).toEqual({ permissions: extended, scope: "turn" });
  });

  it("accept with NO requested profile grants nothing (safe defaults, no undefined leak)", () => {
    expect(
      mapResponseToCodexDecision(pending(PERMS, {}), selected("accept")),
    ).toEqual(EMPTY_GRANT);
  });

  it("decline grants nothing", () => {
    expect(
      mapResponseToCodexDecision(
        pending(PERMS, { permissions: REQUESTED }),
        selected("decline"),
      ),
    ).toEqual(EMPTY_GRANT);
  });

  it("cancel grants nothing", () => {
    expect(
      mapResponseToCodexDecision(
        pending(PERMS, { permissions: REQUESTED }),
        selected("cancel"),
      ),
    ).toEqual(EMPTY_GRANT);
  });

  it("cancelled grants nothing", () => {
    expect(
      mapResponseToCodexDecision(
        pending(PERMS, { permissions: REQUESTED }),
        cancelled(),
      ),
    ).toEqual(EMPTY_GRANT);
  });

  it("an unknown option id grants nothing", () => {
    expect(
      mapResponseToCodexDecision(
        pending(PERMS, { permissions: REQUESTED }),
        selected("forged-grant"),
      ),
    ).toEqual(EMPTY_GRANT);
  });
});

describe("mapResponseToCodexDecision — legacy approval compatibility", () => {
  const optionToDecision: Array<[string, unknown]> = [
    ["accept", "approved"],
    ["acceptForSession", "approved_for_session"],
    ["decline", { denied: { rejection: "User declined this action." } }],
    ["cancel", "abort"],
  ];
  for (const method of LEGACY_RUN_METHODS) {
    for (const [optionId, decision] of optionToDecision) {
      it(`${method} · ${optionId} maps to the legacy ReviewDecision`, () => {
        expect(
          mapResponseToCodexDecision(pending(method), selected(optionId)),
        ).toEqual({ decision });
      });
    }
    it(`${method} · an unknown option fails closed to abort`, () => {
      expect(
        mapResponseToCodexDecision(pending(method), selected("unknown")),
      ).toEqual({ decision: "abort" });
    });
  }
});

describe("SAFETY invariant — an unapproved action NEVER becomes a grant", () => {
  const NON_APPROVALS = [selected("decline"), selected("cancel"), cancelled()];
  const RUNS = new Set(["accept", "acceptForSession"]);

  for (const method of RUN_METHODS) {
    for (const resp of NON_APPROVALS) {
      const label =
        resp.outcome.outcome === "cancelled"
          ? "cancelled"
          : resp.outcome.optionId;
      it(`${method} · "${label}" never maps to an accepting decision`, () => {
        const out = mapResponseToCodexDecision(pending(method), resp) as {
          decision: string;
        };
        expect(RUNS.has(out.decision)).toBe(false);
      });
    }
  }

  for (const method of LEGACY_RUN_METHODS) {
    for (const resp of NON_APPROVALS) {
      const label =
        resp.outcome.outcome === "cancelled"
          ? "cancelled"
          : resp.outcome.optionId;
      it(`${method} · "${label}" never maps to a legacy approval`, () => {
        const out = mapResponseToCodexDecision(pending(method), resp) as {
          decision: unknown;
        };
        expect(out.decision).not.toBe("approved");
        expect(out.decision).not.toBe("approved_for_session");
      });
    }
  }

  for (const resp of NON_APPROVALS) {
    const label =
      resp.outcome.outcome === "cancelled"
        ? "cancelled"
        : resp.outcome.optionId;
    it(`permissions · "${label}" grants no network and no filesystem access`, () => {
      const out = mapResponseToCodexDecision(
        pending(PERMS, {
          permissions: {
            network: { enabled: true },
            fileSystem: { read: ["/x"], write: ["/y"] },
          },
        }),
        resp,
      ) as {
        permissions: {
          network: { enabled: boolean };
          fileSystem: { read: string[]; write: string[] };
        };
      };
      expect(out.permissions.network.enabled).toBe(false);
      expect(out.permissions.fileSystem.read).toEqual([]);
      expect(out.permissions.fileSystem.write).toEqual([]);
    });
  }
});

describe("defaultMethodResponse", () => {
  for (const method of RUN_METHODS) {
    it(`${method} · cancel/decline pass through as {decision}`, () => {
      expect(defaultMethodResponse(method, "cancel")).toEqual({
        decision: "cancel",
      });
      expect(defaultMethodResponse(method, "decline")).toEqual({
        decision: "decline",
      });
    });
  }
  it("permissions · empty grant regardless of the decision word", () => {
    expect(defaultMethodResponse(PERMS, "cancel")).toEqual(EMPTY_GRANT);
    expect(defaultMethodResponse(PERMS, "decline")).toEqual(EMPTY_GRANT);
  });
  for (const method of LEGACY_RUN_METHODS) {
    it(`${method} · cancel aborts and decline carries an explicit rejection`, () => {
      expect(defaultMethodResponse(method, "cancel")).toEqual({
        decision: "abort",
      });
      expect(defaultMethodResponse(method, "decline")).toEqual({
        decision: { denied: { rejection: "User declined this action." } },
      });
    });
  }
});

describe("app-server fallbacks — no-handler auto-deny & timeout/dispose", () => {
  it("no-handler AUTO-DENY declines exec & file-change, grants nothing for permissions", () => {
    // The path wireApproval takes when the adapter never set onApprovalRequest.
    expect(defaultDenyResponse(EXEC)).toEqual({ decision: "decline" });
    expect(defaultDenyResponse(FILE)).toEqual({ decision: "decline" });
    expect(defaultDenyResponse(PERMS)).toEqual(EMPTY_GRANT);
  });

  it("TIMEOUT / dispose cancels exec & file-change, grants nothing for permissions", () => {
    // The path taken on APPROVAL_TIMEOUT_MS and during dispose.
    expect(defaultCancelResponse(EXEC)).toEqual({ decision: "cancel" });
    expect(defaultCancelResponse(FILE)).toEqual({ decision: "cancel" });
    expect(defaultCancelResponse(PERMS)).toEqual(EMPTY_GRANT);
  });

  it("answers deprecated approval names with their legacy ReviewDecision shape", () => {
    for (const method of LEGACY_RUN_METHODS) {
      expect(defaultDenyResponse(method)).toEqual({
        decision: {
          denied: { rejection: "No approval handler is available." },
        },
      });
      expect(defaultCancelResponse(method)).toEqual({ decision: "abort" });
    }
  });
});
