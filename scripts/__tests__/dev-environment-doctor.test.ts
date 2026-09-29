import { expect, it, vi } from "vitest";
import { inspectHostedLive, hostedDiagnostic } from "../dev-environment/hosted-doctor.mjs";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
it("reports absent or denied image reads without mutating the registry or assuming deletion", async () => {
  const state = newHostedGeneration({ owner: "a".repeat(24), identity: "test" });
  state.resources.images = [{ snapshotId: "owned", builder: { id: "bx_owned" } }];
  const before = structuredClone(state), boat = vi.fn(async () => ({ status: 404 }));
  expect((await inspectHostedLive(state, { boat: {} }, { boat }))[0].status).toBe("missing-or-changed");
  boat.mockRejectedValueOnce(new Error("private-provider-body"));
  expect((await inspectHostedLive(state, { boat: {} }, { boat }))[0].status).toBe("unconfirmed");
  expect(state).toEqual(before);
  expect(boat.mock.calls.every(call => (call as any)[0] === "GET")).toBe(true);
});
it("distinguishes a denied snapshot GET from confirmed absence", async () => {
  const state = newHostedGeneration({ owner: "a".repeat(24), identity: "test" });
  state.resources.images = [{ snapshotId: "owned", builder: { id: "bx_owned" } }];
  const checks = await inspectHostedLive(state, { boat: {} }, { boat: async () => ({ status: 403 }) });
  expect(checks[0].status).toBe("unconfirmed");
});
it("reports bounded provider phases and request IDs while withholding credentials and arbitrary error bodies", () => {
  const state = newHostedGeneration({ owner: "a".repeat(24), identity: "test" });
  state.resources.planetscale = { create: { phase: "uncertain", attempt: 2, outcome: 503, requestId: "safe-request-id", body: "private-sentinel" },
    roles: { runtime: { url: "private-url", create: { phase: "rejected", requestId: "bad request/private-sentinel" } } } };
  const diagnostic: any = hostedDiagnostic(state);
  expect(diagnostic.createJournals).toContainEqual({ resource: "database", phase: "uncertain", attempt: 2, outcome: 503, requestId: "safe-request-id" });
  expect(JSON.stringify(diagnostic)).not.toContain("private-");
  expect(diagnostic.createJournals.find(row => row.resource === "database-runtime").requestId).toBeUndefined();
});
