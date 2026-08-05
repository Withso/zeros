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
/** The two methods whose decision is a plain string union. */
const RUN_METHODS: CodexApprovalMethod[] = [EXEC, FILE];

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
});
