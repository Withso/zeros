import { describe, expect, it } from "vitest";
import {
  FIXTURE_REQUEST_OPERATIONS,
  FIXTURE_REQUEST_ROUTES,
  FixtureRequestObservations,
} from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/request-observations";

const pairs = [
  { route: "bootBootstrap", operation: "boot.bootstrap" },
  { route: "bootSync", operation: "boot.sync" },
  { route: "bootActivate", operation: "boot.activate" },
  { route: "bootRefresh", operation: "boot.refresh" },
  { route: "actorConfirm", operation: "actor.confirm" },
  { route: "warmContext", operation: "context.warm" },
  { route: "mirror", operation: "commands.mirror" },
  { route: "seal", operation: "commands.seal" },
  { route: "credentialControls", operation: "credentials.controls" },
] as const;

describe("fixture negotiated boot and mirror measurement inventory", () => {
  it.each(pairs)("counts the exact $route/$operation pair without deriving causal authority", ({ route, operation }) => {
    expect(FIXTURE_REQUEST_ROUTES).toContain(route);
    expect(FIXTURE_REQUEST_OPERATIONS).toContain(operation);
    const observations = new FixtureRequestObservations(2, [{ route, operation, delayMs: 1 }]);
    const start = observations.checkpoint(0);
    const arrival = observations.arrive(route, "POST", observations.nowUs());
    observations.classify(arrival, operation);
    observations.complete(arrival, 403);
    expect(observations.window(start, observations.checkpoint(0))).toMatchObject({
      ingressCount: 1, completionCount: 1,
      routeCounts: { [route]: 1 }, operationArrivalCounts: { [operation]: 1 },
      completionOperationCounts: { [operation]: 1 }, causalCoverage: "unavailable",
      foregroundIngressCount: null, backgroundIngressCount: null, unknownCausalIngressCount: 1,
      requests: [{ route, operation, status: 403 }],
    });
  });

  it("keeps exported inventories frozen and preserves legacy categories", () => {
    expect(Object.isFrozen(FIXTURE_REQUEST_ROUTES)).toBe(true);
    expect(Object.isFrozen(FIXTURE_REQUEST_OPERATIONS)).toBe(true);
    expect(FIXTURE_REQUEST_ROUTES).toContain("commands");
    expect(FIXTURE_REQUEST_OPERATIONS).toContain("commands.claim");
    expect(new Set(FIXTURE_REQUEST_ROUTES).size).toBe(FIXTURE_REQUEST_ROUTES.length);
    expect(new Set(FIXTURE_REQUEST_OPERATIONS).size).toBe(FIXTURE_REQUEST_OPERATIONS.length);
  });

  it("rejects a boot operation attached to the legacy commands route", () => {
    expect(() => new FixtureRequestObservations(2, [{ route: "commands", operation: "boot.bootstrap", delayMs: 1 }]))
      .toThrow("fixture_request_delay_invalid");
  });

  it("rejects a mirror operation attached to a boot route", () => {
    expect(() => new FixtureRequestObservations(2, [{ route: "bootSync", operation: "commands.mirror", delayMs: 1 }]))
      .toThrow("fixture_request_delay_invalid");
  });

  it("retains unknown classification when an operation belongs to a different route", () => {
    const observations = new FixtureRequestObservations(2), start = observations.checkpoint(0);
    const arrival = observations.arrive("mirror", "POST", observations.nowUs());
    observations.classify(arrival, "boot.bootstrap");
    observations.complete(arrival, 422);
    expect(observations.window(start, observations.checkpoint(0))).toMatchObject({
      routeCounts: { mirror: 1 }, operationArrivalCounts: { unknown: 1 },
      completionOperationCounts: { unknown: 1 }, detailsComplete: true, causalCoverage: "unavailable",
    });
  });

  it("rejects a seal operation attached to the mirror route", () => {
    expect(() => new FixtureRequestObservations(2, [{ route: "mirror", operation: "commands.seal", delayMs: 1 }]))
      .toThrow("fixture_request_delay_invalid");
  });

  it("rejects a legacy claim operation attached to the seal route", () => {
    expect(() => new FixtureRequestObservations(2, [{ route: "seal", operation: "commands.claim", delayMs: 1 }]))
      .toThrow("fixture_request_delay_invalid");
  });

  it("keeps mirror traffic unknown when it carries a seal operation label", () => {
    const observations = new FixtureRequestObservations(2), start = observations.checkpoint(0);
    const arrival = observations.arrive("mirror", "POST", observations.nowUs());
    observations.classify(arrival, "commands.seal");
    observations.complete(arrival, 403);
    expect(observations.window(start, observations.checkpoint(0))).toMatchObject({
      ingressCount: 1, routeCounts: { mirror: 1 }, operationArrivalCounts: { unknown: 1 },
      completionOperationCounts: { unknown: 1 }, detailsComplete: true, causalCoverage: "unavailable",
      foregroundIngressCount: null, backgroundIngressCount: null,
    });
  });

  it("retains the real credential-control 404 without fabricating successful control evidence", () => {
    const observations = new FixtureRequestObservations(2, [{ route: "credentialControls", operation: "credentials.controls", delayMs: 0 }]);
    const start = observations.checkpoint(0);
    const arrival = observations.arrive("credentialControls", "POST", observations.nowUs());
    observations.classify(arrival, "credentials.controls");
    observations.complete(arrival, 404);
    expect(observations.window(start, observations.checkpoint(0))).toMatchObject({
      ingressCount: 1, completionCount: 1, routeCounts: { credentialControls: 1 },
      operationArrivalCounts: { "credentials.controls": 1 }, completionOperationCounts: { "credentials.controls": 1 },
      requests: [{ route: "credentialControls", operation: "credentials.controls", status: 404 }],
      detailsComplete: true, causalCoverage: "unavailable", foregroundIngressCount: null, backgroundIngressCount: null,
      unknownCausalIngressCount: 1,
    });
  });

  it("rejects credential controls attached to the execution route", () => {
    expect(() => new FixtureRequestObservations(2, [{ route: "execution", operation: "credentials.controls", delayMs: 1 }]))
      .toThrow("fixture_request_delay_invalid");
  });

  it("rejects execution admission attached to the credential-control route", () => {
    expect(() => new FixtureRequestObservations(2, [{ route: "credentialControls", operation: "credentials.admit", delayMs: 1 }]))
      .toThrow("fixture_request_delay_invalid");
  });

  it("keeps a wrongly labelled credential-control arrival unknown", () => {
    const observations = new FixtureRequestObservations(2), start = observations.checkpoint(0);
    const arrival = observations.arrive("credentialControls", "POST", observations.nowUs());
    observations.classify(arrival, "credentials.admit");
    observations.complete(arrival, 404);
    expect(observations.window(start, observations.checkpoint(0))).toMatchObject({
      routeCounts: { credentialControls: 1 }, operationArrivalCounts: { unknown: 1 }, completionOperationCounts: { unknown: 1 },
      requests: [{ route: "credentialControls", operation: "unknown", status: 404 }],
      causalCoverage: "unavailable", foregroundIngressCount: null, backgroundIngressCount: null,
    });
  });
});
