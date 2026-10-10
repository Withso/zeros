// DRAFT ONLY during W6 snapshot hold. Intended destination:
// apps/desktop/src/engine/agents/__tests__/cloud-actor-authority.test.ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudActorProvenance } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudActorAuthorityRegistry, isCloudAuthorizedActor } from "../cloud-agent-lease";

afterEach(() => vi.useRealTimers());

function fixture(maxEntries = 4) {
  vi.useFakeTimers();
  let wall = 1_790_000_000_000, monotonic = 100, engineLive = true;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const admission: CloudActorProvenance = { scope: { ...scope }, actorSessionId: randomUUID(), authorityEpoch: 3,
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" },
    confirmedUntilMs: wall + 10_000, actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(),
      deviceKeyVersion: 2, role: "owner", fingerprint: "a".repeat(64) } };
  const registry = new CloudActorAuthorityRegistry({ scope, maxEntries, engineLive: () => engineLive,
    time: { wall: () => wall, monotonic: () => monotonic } });
  return { scope, admission, registry,
    loseEngine: () => { engineLive = false; },
    rollbackWall: (ms: number) => { wall -= ms; },
    future: (ms = 10_000) => wall + ms,
    advanceClockOnly(ms: number) { wall += ms; monotonic += ms; },
    async advance(ms: number) { wall += ms; monotonic += ms; await vi.advanceTimersByTimeAsync(ms); } };
}

describe("verified detached actor and funding-grant authorization for the negotiated boot", () => {
  it("mints a frozen principal only from confirmed registry admission, never structural caller fields", () => {
    const f = fixture();
    try {
      const actor = f.registry.confirm(f.admission);
      expect(isCloudAuthorizedActor(actor)).toBe(true);
      expect(isCloudAuthorizedActor({ ...actor })).toBe(false);
      expect(isCloudAuthorizedActor({ provenance: f.admission, assertLive() {} })).toBe(false);
      expect(Object.isFrozen(actor)).toBe(true);
      expect(Object.isFrozen(actor.provenance.actor)).toBe(true);
      f.admission.actor.role = "viewer";
      f.admission.scope.workspaceId = randomUUID();
      expect(f.registry.authorizeCurrent(actor.provenance.actorSessionId, "run")).toBe(actor);
      expect(actor.provenance.actor.role).toBe("owner");
    } finally { f.registry.dispose(); }
  });

  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)(
    "rejects a foreign %s without minting authority", field => {
      const f = fixture();
      try {
        const foreign = structuredClone(f.admission);
        if (field === "generation" || field === "fundingOwnerEpoch") foreign.scope[field]++;
        else foreign.scope[field] = randomUUID();
        if (field === "fundingOwnerUserId") foreign.actor.userId = foreign.scope.fundingOwnerUserId;
        expect(() => f.registry.confirm(foreign)).toThrow(expect.objectContaining({ code: "cloud_validation_access_denied" }));
        expect(() => f.registry.authorizeCurrent(foreign.actorSessionId, "run")).toThrow();
      } finally { f.registry.dispose(); }
    });

  it("permits authenticated inspection but refuses missing funding consent and viewer execution", () => {
    const f = fixture();
    try {
      const other = { ...f.admission, fundingConsentVersion: null, fundingGrant: null,
        actor: { ...f.admission.actor, userId: randomUUID(), role: "developer" as const } };
      f.registry.confirm(other);
      expect(() => f.registry.authorizeCurrent(other.actorSessionId, "read")).not.toThrow();
      expect(() => f.registry.authorizeCurrent(other.actorSessionId, "run")).toThrow(expect.objectContaining({ code: "cloud_validation_access_denied" }));
      const viewer = { ...f.admission, fundingConsentVersion: null, fundingGrant: null,
        actorSessionId: randomUUID(), actor: { ...f.admission.actor, role: "viewer" as const } };
      f.registry.confirm(viewer);
      expect(() => f.registry.authorizeCurrent(viewer.actorSessionId, "read")).not.toThrow();
      expect(() => f.registry.authorizeCurrent(viewer.actorSessionId, "run")).toThrow();
      expect(() => f.registry.authorizeCurrent(viewer.actorSessionId, "edit")).toThrow();
    } finally { f.registry.dispose(); }
  });

  it.each(["share", "general-access"] as const)("permits member runs only with actual verified %s grant provenance", kind => {
    const f = fixture();
    try {
      for (const role of ["prompter", "developer"] as const) {
        const admission: CloudActorProvenance = { ...f.admission, actorSessionId: randomUUID(),
          actor: { ...f.admission.actor, userId: randomUUID(), role },
          fundingGrant: { kind, grantId: randomUUID(), grantRevision: 7 } };
        const actor = f.registry.confirm(admission);
        expect(() => actor.assertLive("run")).not.toThrow();
        expect(f.registry.reauthorizeRecorded(structuredClone(actor.provenance), "run")).toBe(actor);
        if (role === "prompter") expect(() => actor.assertLive("edit")).toThrow();
        else expect(() => actor.assertLive("edit")).not.toThrow();
      }
    } finally { f.registry.dispose(); }
  });

  it("does not treat a funding format version or another owner's implicit grant as consent", () => {
    const f = fixture();
    try {
      const member = { ...f.admission, actor: { ...f.admission.actor, userId: randomUUID(), role: "developer" as const } };
      for (const invalid of [member, { ...member, fundingGrant: null },
        { ...member, fundingGrant: { kind: "share", grantRevision: 1 } }]) {
        expect(() => f.registry.confirm(invalid)).toThrow(expect.objectContaining({ code: "cloud_validation_authority_response_invalid" }));
      }
    } finally { f.registry.dispose(); }
  });

  it.each(["grantId", "grantRevision"] as const)("refuses altered recorded %s without touching the current actor", field => {
    const f = fixture();
    try {
      const admitted: CloudActorProvenance = { ...f.admission,
        actor: { ...f.admission.actor, userId: randomUUID(), role: "developer" },
        fundingGrant: { kind: "share", grantId: randomUUID(), grantRevision: 2 } };
      const actor = f.registry.confirm(admitted), changed = structuredClone(actor.provenance);
      if (changed.fundingGrant?.kind !== "share") throw new Error("Fixture funding grant missing");
      if (field === "grantId") changed.fundingGrant.grantId = randomUUID();
      else changed.fundingGrant.grantRevision++;
      expect(() => f.registry.reauthorizeRecorded(changed, "run"))
        .toThrow(expect.objectContaining({ code: "cloud_validation_access_denied" }));
      expect(actor.signal.aborted).toBe(false);
    } finally { f.registry.dispose(); }
  });

  it("funding grant or role removal retires prior execution authority immediately", () => {
    const f = fixture();
    try {
      const admitted: CloudActorProvenance = { ...f.admission,
        actor: { ...f.admission.actor, userId: randomUUID(), role: "developer" },
        fundingGrant: { kind: "share", grantId: randomUUID(), grantRevision: 2 } };
      const old = f.registry.confirm(admitted), accepted = structuredClone(old.provenance);
      const current = f.registry.confirm({ ...admitted, authorityEpoch: admitted.authorityEpoch + 1,
        actor: { ...admitted.actor, role: "viewer", fingerprint: "c".repeat(64) },
        fundingConsentVersion: null, fundingGrant: null });
      expect(old.signal.aborted).toBe(true);
      expect(() => f.registry.reauthorizeRecorded(accepted, "run")).toThrow();
      expect(() => current.assertLive("read")).not.toThrow();
      expect(() => current.assertLive("run")).toThrow();
      expect(() => f.registry.confirm(admitted)).toThrow();
    } finally { f.registry.dispose(); }
  });

  it("reauthorizes accepted provenance after socket disconnect using only a fresh verified principal", async () => {
    const f = fixture();
    try {
      const actor = f.registry.confirm(f.admission), accepted = structuredClone(actor.provenance);
      await f.advance(5_000);
      const renewed = f.registry.confirm({ ...f.admission, confirmedUntilMs: f.future() });
      expect(renewed).toBe(actor);
      await f.advance(5_001); // Original accepted deadline is now past.
      expect(f.registry.reauthorizeRecorded(accepted, "run")).toBe(actor);
      expect(actor.signal.aborted).toBe(false);
      // No websocket/client callback or credential appears in provenance.
      expect(Object.keys(actor.provenance).sort()).toEqual(["actor", "actorSessionId", "authorityEpoch", "confirmedUntilMs",
        "fundingConsentVersion", "fundingGrant", "scope"]);
    } finally { f.registry.dispose(); }
  });

  it.each(["deviceId", "deviceKeyVersion", "fingerprint", "role", "userId"] as const)(
    "refuses a queued record with changed %s at dispatch", field => {
      const f = fixture();
      try {
        const actor = f.registry.confirm(f.admission), forged = structuredClone(actor.provenance);
        if (field === "deviceKeyVersion") forged.actor.deviceKeyVersion++;
        else if (field === "role") forged.actor.role = "manager";
        else if (field === "fingerprint") forged.actor.fingerprint = "b".repeat(64);
        else forged.actor[field] = randomUUID();
        if (field === "userId") forged.fundingGrant = { kind: "share", grantId: randomUUID(), grantRevision: 1 };
        expect(() => f.registry.reauthorizeRecorded(forged, "run")).toThrow(expect.objectContaining({ code: "cloud_validation_access_denied" }));
        expect(actor.signal.aborted).toBe(false);
      } finally { f.registry.dispose(); }
    });

  it("a newer verified authority epoch retires old proofs and stale renewal cannot restore them", () => {
    const f = fixture();
    try {
      const old = f.registry.confirm(f.admission), accepted = structuredClone(old.provenance);
      const current = f.registry.confirm({ ...f.admission, authorityEpoch: 4 });
      expect(old.signal.aborted).toBe(true);
      expect(current).not.toBe(old);
      expect(() => f.registry.reauthorizeRecorded(accepted, "run")).toThrow();
      expect(() => f.registry.confirm(f.admission)).toThrow();
      expect(() => old.assertLive("run")).toThrow();
      expect(f.registry.authorizeCurrent(current.provenance.actorSessionId, "run")).toBe(current);
    } finally { f.registry.dispose(); }
  });

  it("expires without CP and no fresh confirmation can revive the retired principal", async () => {
    const f = fixture();
    try {
      const old = f.registry.confirm(f.admission);
      await f.advance(10_001);
      expect(old.signal.aborted).toBe(true);
      expect(() => old.assertLive("run")).toThrow(expect.objectContaining({ code: "cloud_validation_session_expired" }));
      expect(() => f.registry.authorizeCurrent(f.admission.actorSessionId, "run")).toThrow();
      const current = f.registry.confirm({ ...f.admission, confirmedUntilMs: f.future() });
      expect(current).not.toBe(old);
      expect(() => current.assertLive("run")).not.toThrow();
      expect(() => old.assertLive("run")).toThrow();
    } finally { f.registry.dispose(); }
  });

  it("wall-clock rollback does not extend an already confirmed monotonic deadline", async () => {
    const f = fixture();
    try {
      const actor = f.registry.confirm(f.admission);
      f.rollbackWall(60_000);
      await f.advance(10_001);
      expect(actor.signal.aborted).toBe(true);
      expect(() => actor.assertLive("run")).toThrow();
    } finally { f.registry.dispose(); }
  });

  it("a late timer cannot let a renewal revive an already expired principal", () => {
    const f = fixture();
    try {
      const old = f.registry.confirm(f.admission);
      f.advanceClockOnly(10_001);
      const current = f.registry.confirm({ ...f.admission, confirmedUntilMs: f.future() });
      expect(current).not.toBe(old);
      expect(old.signal.aborted).toBe(true);
      expect(() => old.assertLive("run")).toThrow();
      expect(() => current.assertLive("run")).not.toThrow();
    } finally { f.registry.dispose(); }
  });

  it("a new verified device-key revision supersedes its proof and a stale callback cannot retire the replacement", () => {
    const f = fixture();
    try {
      const old = f.registry.confirm(f.admission);
      const current = f.registry.confirm({ ...f.admission,
        actor: { ...f.admission.actor, deviceKeyVersion: 3, fingerprint: "b".repeat(64) } });
      expect(current).not.toBe(old);
      expect(old.signal.aborted).toBe(true);
      expect(() => f.registry.confirm(f.admission)).toThrow();
      expect(() => current.assertLive("run")).not.toThrow();
      expect(current.signal.aborted).toBe(false);
    } finally { f.registry.dispose(); }
  });

  it("conflicting authority cannot be revived by a later renewal of the previously rejected identity", () => {
    const f = fixture();
    try {
      const old = f.registry.confirm(f.admission);
      expect(() => f.registry.confirm({ ...f.admission, actor: { ...f.admission.actor, role: "developer", fingerprint: "c".repeat(64) } })).toThrow();
      expect(old.signal.aborted).toBe(true);
      expect(() => f.registry.confirm({ ...f.admission, confirmedUntilMs: f.future() })).toThrow();
      expect(() => f.registry.authorizeCurrent(f.admission.actorSessionId, "run")).toThrow();
    } finally { f.registry.dispose(); }
  });

  it("rejects a genuine opaque principal minted by a different registry", () => {
    const f = fixture(), other = fixture();
    try {
      const actor = other.registry.confirm(other.admission);
      expect(isCloudAuthorizedActor(actor)).toBe(true);
      expect(() => f.registry.assertActor(actor)).toThrow(expect.objectContaining({ code: "cloud_validation_access_denied" }));
      const local = f.registry.confirm(f.admission);
      expect(() => f.registry.assertActor(local)).not.toThrow();
    } finally { f.registry.dispose(); other.registry.dispose(); }
  });

  it.each(["epoch", "key", "grant"] as const)("retains %s high-water after expiry and unrelated admission", async variant => {
    const f = fixture();
    try {
      const original: CloudActorProvenance = structuredClone(f.admission);
      if (variant === "grant") {
        original.actor.userId = randomUUID(); original.actor.role = "developer";
        original.fundingGrant = { kind: "share", grantId: randomUUID(), grantRevision: 2 };
      }
      f.registry.confirm(original);
      const newer = structuredClone(original); newer.confirmedUntilMs = f.future(1_000);
      if (variant === "epoch") newer.authorityEpoch++;
      else if (variant === "key") { newer.actor.deviceKeyVersion++; newer.actor.fingerprint = "b".repeat(64); }
      else if (newer.fundingGrant?.kind === "share") newer.fundingGrant.grantRevision++;
      const current = f.registry.confirm(newer);
      await f.advance(1_001);
      expect(current.signal.aborted).toBe(true);
      f.registry.confirm({ ...f.admission, actorSessionId: randomUUID(), confirmedUntilMs: f.future() });
      // The original proof is still future-dated, but its authority was replaced.
      expect(() => f.registry.confirm(original)).toThrow();
      expect(() => f.registry.reauthorizeRecorded(original, "run")).toThrow();
    } finally { f.registry.dispose(); }
  });

  it.each(["epoch", "grant"] as const)("a higher %s cannot replace the user or device of an existing actor session", advancement => {
    for (const field of ["userId", "deviceId"] as const) {
      const f = fixture();
      try {
        const original: CloudActorProvenance = { ...f.admission,
          actor: { ...f.admission.actor, userId: randomUUID(), role: "developer" },
          fundingGrant: { kind: "share", grantId: randomUUID(), grantRevision: 2 } };
        const current = f.registry.confirm(original), swapped = structuredClone(original);
        swapped.actor[field] = randomUUID();
        if (advancement === "epoch") swapped.authorityEpoch++;
        else if (swapped.fundingGrant?.kind === "share") swapped.fundingGrant.grantRevision++;
        expect(() => f.registry.confirm(swapped))
          .toThrow(expect.objectContaining({ code: "cloud_validation_authority_response_invalid" }));
        expect(current.signal.aborted).toBe(true);
        expect(() => f.registry.confirm(original)).toThrow();
        // Actual fresh admission has a different actor session and grant.
        const fresh = { ...swapped, actorSessionId: randomUUID(),
          fundingGrant: { kind: "share" as const, grantId: randomUUID(), grantRevision: 1 } };
        expect(() => f.registry.confirm(fresh).assertLive("run")).not.toThrow();
      } finally { f.registry.dispose(); }
    }
  });

  it("a delayed older confirmation cannot shorten or extend the current proof deadline", async () => {
    const f = fixture();
    try {
      const actor = f.registry.confirm(f.admission);
      await f.advance(5_000);
      f.registry.confirm({ ...f.admission, confirmedUntilMs: f.future() });
      f.registry.confirm(f.admission);
      await f.advance(6_000);
      expect(() => actor.assertLive("run")).not.toThrow();
      await f.advance(4_001);
      expect(() => actor.assertLive("run")).toThrow();
    } finally { f.registry.dispose(); }
  });

  it("engine authority loss fences every cached actor synchronously", () => {
    const f = fixture();
    try {
      const one = f.registry.confirm(f.admission), two = f.registry.confirm({ ...f.admission, actorSessionId: randomUUID(),
        actor: { ...f.admission.actor, deviceId: randomUUID() } });
      f.loseEngine();
      expect(() => one.assertLive("run")).toThrow(expect.objectContaining({ code: "cloud_validation_lifecycle_superseded" }));
      expect(one.signal.aborted).toBe(true);
      expect(two.signal.aborted).toBe(true);
      expect(() => f.registry.confirm(f.admission)).toThrow();
    } finally { f.registry.dispose(); }
  });

  it("explicit revoke does not affect another device and delayed renewal cannot revive that proof", () => {
    const f = fixture();
    try {
      const one = f.registry.confirm(f.admission), two = f.registry.confirm({ ...f.admission, actorSessionId: randomUUID(),
        actor: { ...f.admission.actor, deviceId: randomUUID() } });
      f.registry.revoke(one.provenance.actorSessionId);
      expect(one.signal.aborted).toBe(true);
      expect(two.signal.aborted).toBe(false);
      expect(() => f.registry.confirm(f.admission)).toThrow();
      expect(() => f.registry.reauthorizeRecorded(one.provenance, "run")).toThrow();
      expect(() => two.assertLive("run")).not.toThrow();
    } finally { f.registry.dispose(); }
  });

  it("rejects oversized lifetime and malformed metadata with a bounded closed cause", () => {
    const f = fixture();
    try {
      const malformed = { ...f.admission, rawDiagnostic: "do-not-log-this" };
      for (const value of [malformed, { ...f.admission, confirmedUntilMs: f.future(60_000) },
        { ...f.admission, actor: { ...f.admission.actor, deviceKeyVersion: undefined } }]) {
        expect(() => f.registry.confirm(value)).toThrow(expect.objectContaining({ code: "cloud_validation_authority_response_invalid" }));
        try { f.registry.confirm(value); } catch (error) { expect(String(error)).not.toContain("do-not-log-this"); }
      }
    } finally { f.registry.dispose(); }
  });

  it("bounds confirmed actors without evicting another live authorization and dispose is final", () => {
    const f = fixture(1);
    const one = f.registry.confirm(f.admission);
    expect(() => f.registry.confirm({ ...f.admission, actorSessionId: randomUUID() }))
      .toThrow(expect.objectContaining({ code: "cloud_validation_execution_limit" }));
    expect(() => one.assertLive("run")).not.toThrow();
    f.registry.dispose();
    expect(one.signal.aborted).toBe(true);
    expect(() => f.registry.confirm(f.admission)).toThrow();
    expect(() => f.registry.authorizeCurrent(f.admission.actorSessionId, "run")).toThrow();
  });
});
