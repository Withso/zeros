import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { RolloutFlagReader } from "../rollout-flags.js";
import { buildCapabilityConformance, conformanceOutcome, seedConformanceState } from "./capability-conformance-test-utils.js";
import {
  API_ENGINE_CAPABILITY_PIN,
  checkEngineCapability,
  createApiEngineCapabilityVerifier,
  createRealtimeClientCapabilityVerifier,
  ENGINE_CAPABILITY_HEADER,
  REALTIME_CLIENT_CAPABILITY_PIN,
  type CapabilityPlacementResolver,
} from "./capability-service-verifier.js";
import {
  TEST_CAPABILITY_HEADER,
  TEST_CAPABILITY_IDS as ids,
  TEST_CAPABILITY_NOW_S,
  signTestCapability,
  testEngineClaims,
  testSigningJwk,
} from "./capability-verifier-test-utils.js";
import { createCloudCommandRoutes } from "./command-routes.js";
import type { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { EngineAuthorityCache, type EngineAuthorityEntry } from "./engine-authority-cache.js";

const fixture = buildCapabilityConformance();
const NOW_MS = TEST_CAPABILITY_NOW_S * 1000;
const keys = [testSigningJwk("cap-2026-10-a")];
const engineToken = (overrides: Record<string, unknown> = {}) =>
  signTestCapability(TEST_CAPABILITY_HEADER, testEngineClaims(overrides), TEST_CAPABILITY_HEADER.kid);
const current: CapabilityPlacementResolver = async () => ({ generation: 7, engineInstanceId: ids.engine });

function apiVerifier(placement: CapabilityPlacementResolver = current, keySet: () => readonly unknown[] = () => keys) {
  return createApiEngineCapabilityVerifier({ issuer: fixture.issuer, keys: keySet, placement, now: () => NOW_MS });
}

describe("S1 conformance vectors on the control-plane verifiers", () => {
  const verifiers = [
    ["api", API_ENGINE_CAPABILITY_PIN, createApiEngineCapabilityVerifier],
    ["realtime", REALTIME_CLIENT_CAPABILITY_PIN, createRealtimeClientCapabilityVerifier],
  ] as const;
  for (const [service, pin, create] of verifiers) {
    for (const vector of fixture.vectors.filter(v => v.pin.aud === pin.aud && v.pin.knd === pin.knd)) {
      it(`${service}: ${vector.name}`, async () => {
        // The placement answers with the vector's current generation and
        // instance; the request below carries neither.
        const placement = vi.fn<CapabilityPlacementResolver>(async () =>
          ({ generation: vector.context.generation, engineInstanceId: vector.context.engineInstanceId }));
        const verifier = create({ issuer: fixture.issuer, keys: () => fixture.keys, placement, now: () => vector.nowMs });
        seedConformanceState(verifier.verifier, vector);
        const request = {
          workspaceId: vector.context.workspaceId, organizationId: vector.context.organizationId,
          ...(vector.context.route ? { route: vector.context.route } : {}),
          ...(vector.context.proof ? { proof: vector.context.proof } : {}),
          ...(vector.context.scope !== undefined ? { scope: vector.context.scope } : {}),
        };
        let result = await verifier.verify(vector.token, request);
        if (vector.repeat) result = await verifier.verify(vector.token, request);
        expect(conformanceOutcome(result)).toEqual(vector.expect);
        expect(placement).toHaveBeenCalledWith({ workspaceId: vector.context.workspaceId, organizationId: vector.context.organizationId });
      });
    }
  }

  it("covers every engine-token and relay-admission vector", () => {
    expect(fixture.vectors.filter(v => v.pin.aud === "zeros:api").length).toBeGreaterThan(10);
    expect(fixture.vectors.filter(v => v.pin.aud === "zeros:realtime").length).toBeGreaterThan(10);
  });
});

describe("control-plane capability placement", () => {
  it("takes the generation and engine instance from the resolver, never the request", async () => {
    const replaced = apiVerifier(async () => ({ generation: 8, engineInstanceId: ids.engine }));
    expect(conformanceOutcome(await replaced.verify(engineToken(), { workspaceId: ids.workspace, organizationId: ids.org,
      generation: 7, engineInstanceId: ids.engine } as never))).toEqual({ ok: false, code: "capability_generation_mismatch", step: 8 });
    const handover = apiVerifier(async () => ({ generation: 7, engineInstanceId: null }));
    expect(conformanceOutcome(await handover.verify(engineToken(), { workspaceId: ids.workspace, organizationId: ids.org })))
      .toEqual({ ok: false, code: "capability_generation_mismatch", step: 8 });
  });

  it("fails a workspace with no placement at step 8, after the earlier steps in order", async () => {
    const none = apiVerifier(async () => null);
    expect(conformanceOutcome(await none.verify(engineToken(), { workspaceId: ids.workspace, organizationId: ids.org })))
      .toEqual({ ok: false, code: "capability_workspace_mismatch", step: 8 });
    expect(conformanceOutcome(await none.verify("not-a-token", { workspaceId: ids.workspace, organizationId: ids.org })))
      .toEqual({ ok: false, code: "capability_malformed", step: 1 });
    expect(conformanceOutcome(await none.verify(engineToken({ iss: "https://other.example.test" }), { workspaceId: ids.workspace, organizationId: ids.org })))
      .toEqual({ ok: false, code: "capability_issuer_mismatch", step: 5 });
  });

  it("follows the in-process key set when it is replaced", async () => {
    let set: readonly unknown[] = [testSigningJwk("cap-2026-10-b")];
    const verifier = apiVerifier(current, () => set);
    const request = { workspaceId: ids.workspace, organizationId: ids.org };
    expect(conformanceOutcome(await verifier.verify(engineToken(), request))).toEqual({ ok: false, code: "capability_key_unknown", step: 3 });
    set = [testSigningJwk("cap-2026-10-b"), keys[0]!];
    expect(conformanceOutcome(await verifier.verify(engineToken(), request))).toEqual({ ok: true });
  });
});

describe("engine route families on api", () => {
  const enabled = new Set<string>([ids.org]);
  const flags: RolloutFlagReader = { enabled: (org, flag) => flag === "capabilities" && enabled.has(org) };
  const request = { workspaceId: ids.workspace, organizationId: ids.org, generation: 7, engineInstanceId: ids.engine };

  it("changes nothing with the flag off or without a token", async () => {
    const placement = vi.fn(current);
    const gate = { flags: { enabled: () => false }, verifier: apiVerifier(placement) };
    expect(await checkEngineCapability(gate, "garbage", request, "engine:history.write")).toBeNull();
    expect(await checkEngineCapability({ flags, verifier: apiVerifier(placement) }, undefined, request, "engine:history.write")).toBeNull();
    expect(await checkEngineCapability(undefined, "garbage", request, "engine:history.write")).toBeNull();
    expect(placement).not.toHaveBeenCalled();
  });

  it("pins knd engine, the route family's scope and the request's placement", async () => {
    const gate = { flags, verifier: apiVerifier() };
    expect(await checkEngineCapability(gate, engineToken(), request, "engine:history.write")).toBeNull();
    expect(await checkEngineCapability(gate, engineToken({ scp: ["engine:checkpoint"] }), request, "engine:history.write"))
      .toEqual({ status: 403, code: "capability_scope_denied" });
    expect(await checkEngineCapability(gate, engineToken(), { ...request, generation: 6 }, "engine:history.write"))
      .toEqual({ status: 401, code: "capability_generation_mismatch" });
    expect(await checkEngineCapability(gate, engineToken(), { ...request, workspaceId: randomUUID() }, "engine:history.write"))
      .toEqual({ status: 401, code: "capability_workspace_mismatch" });
    expect(await checkEngineCapability(gate, "x.y.z", request, "engine:history.write")).toEqual({ status: 401, code: "capability_malformed" });
  });

  it("rejects a bad engine token on the command mirror route before the service runs", async () => {
    const mirror = vi.fn(async () => ({ ok: true }));
    const routes = createCloudCommandRoutes({ mirror } as unknown as DatabaseCloudWorkspaceCommandService,
      { capabilities: { flags, verifier: apiVerifier() } });
    const batch = { version: 1, bootId: randomUUID(), writerEpoch: randomUUID(), batchId: randomUUID(), after: 0, through: 1,
      changes: [{ sequence: 1, conversationId: "chat", revision: 0, paused: false }] };
    const post = (capability?: string) => routes.request("/internal/v2/cloud-workspaces/engine/commands/mirror", {
      method: "POST", body: JSON.stringify({ ...request, batch }),
      headers: { authorization: `Bearer zwh_${"a".repeat(43)}`, "content-type": "application/json",
        ...(capability ? { [ENGINE_CAPABILITY_HEADER]: capability } : {}) } });
    const denied = await post(engineToken({ gen: 6 }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "capability_generation_mismatch" });
    expect(mirror).not.toHaveBeenCalled();
    expect((await post(engineToken())).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(mirror).toHaveBeenCalledTimes(2);
  });
});

describe("authority cache placement", () => {
  const WS = ids.workspace, ORG = ids.org;
  const entry = (overrides: Partial<EngineAuthorityEntry> = {}): EngineAuthorityEntry => ({
    authorityEpoch: 7, accountUserId: ids.user, heartbeatTokenHash: Buffer.alloc(32), revoked: false, setupEnrolled: true,
    runtimeReady: false, leaseExpiresAtMs: NOW_MS + 60_000, deadlineMs: NOW_MS + 30_000, runtimeBootId: null, ...overrides,
  });
  function harness(value: (key: { generation: number }) => EngineAuthorityEntry | null) {
    let handlers!: { onNotification: (payload: string) => void; onReady: () => void; onUnavailable: () => void };
    const cache = new EngineAuthorityCache({
      load: async key => value(key), now: () => NOW_MS, summaryMs: 0, logger: { warn: vi.fn(), info: vi.fn() },
      subscribe: next => { handlers = next; return { start: async () => {}, healthy: () => true, stop: async () => {} }; },
    });
    cache.start();
    handlers.onReady();
    const load = async (generation: number, engineInstanceId = ids.engine) => {
      cache.ensure({ workspaceId: WS, organizationId: ORG, generation, engineInstanceId, workosEnabled: false });
      await vi.waitFor(() => expect(cache.stats().loads).toBeGreaterThan(0));
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    return { cache, load, get handlers() { return handlers; } };
  }

  it("answers the one usable entry and forgets it on invalidation or a lost feed", async () => {
    const h = harness(() => entry());
    expect(h.cache.placement(WS, ORG)).toBeUndefined();
    await h.load(7);
    expect(h.cache.placement(WS.toUpperCase(), ORG)).toEqual({ generation: 7, engineInstanceId: ids.engine });
    expect(h.cache.placement(WS, randomUUID())).toBeUndefined();
    h.handlers.onNotification(`w:${WS}`);
    expect(h.cache.placement(WS, ORG)).toBeUndefined();
    await h.load(7);
    h.handlers.onUnavailable();
    expect(h.cache.placement(WS, ORG)).toBeUndefined();
  });

  it("never answers a revoked or unenrolled entry, nor an ambiguous pair", async () => {
    expect(await (async () => { const h = harness(() => entry({ revoked: true })); await h.load(7); return h.cache.placement(WS, ORG); })()).toBeUndefined();
    expect(await (async () => { const h = harness(() => entry({ setupEnrolled: false })); await h.load(7); return h.cache.placement(WS, ORG); })()).toBeUndefined();
    const h = harness(() => entry());
    await h.load(7);
    await h.load(7, "99999999-9999-4999-8999-999999999999");
    expect(h.cache.placement(WS, ORG)).toBeUndefined();
  });
});
