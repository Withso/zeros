import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import * as Wire from "../../../packages/protocol/src/cloud-events.js";
import * as timing from "./request-timing.js";

const origin = (patch: Partial<Wire.CloudAgentTurnRequestOrigin> = {}): Wire.CloudAgentTurnRequestOrigin => ({
  version: 1, organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
  mode: "legacy", bootId: null, writerEpoch: null, clockId: randomUUID(), spanId: randomUUID(), flightId: null,
  producer: "foreground", operation: "commands.mutate", intent: { kind: "command", commandId: randomUUID(),
    conversationId: "conversation-1", turnId: "turn-1", executionId: null }, ...patch,
});
function expected(value: Wire.CloudAgentTurnRequestOrigin) {
  return { organizationId: value.organizationId, workspaceId: value.workspaceId, generation: value.generation,
    engineInstanceId: value.engineInstanceId, mode: value.mode, bootId: value.bootId, writerEpoch: value.writerEpoch,
    operation: value.operation, intent: value.intent };
}
function observed() {
  const summaries: timing.RequestDatabaseCost[] = [];
  const app = new Hono();
  app.use("*", timing.requestTiming({ slowMs: Infinity, costObserver: value => { summaries.push(value); } }));
  return { app, summaries };
}

describe("authenticated request-cost origin observation", () => {
  it("keeps raw header-only and early-denied requests unverified", async () => {
    const value = origin(), { app, summaries } = observed();
    app.post("/engine", c => c.json({}, 403));
    expect((await app.request("/engine", { method: "POST", headers: {
      [Wire.CLOUD_AGENT_TURN_ORIGIN_HEADER]: Wire.encodeCloudAgentTurnRequestOrigin(value),
    } })).status).toBe(403);
    expect(summaries[0]).toMatchObject({ origin: null, originCoverage: "unverified", causalCoverage: "unavailable" });
  });

  it("records only an exact service-derived scope, operation and intent", async () => {
    const value = origin(), { app, summaries } = observed();
    app.post("/engine", c => {
      expect(timing.recordVerifiedEngineRequestOrigin(c.req.header(Wire.CLOUD_AGENT_TURN_ORIGIN_HEADER), expected(value))).toBe(true);
      return c.json({}, 202);
    });
    expect((await app.request("/engine", { method: "POST", headers: {
      [Wire.CLOUD_AGENT_TURN_ORIGIN_HEADER]: Wire.encodeCloudAgentTurnRequestOrigin(value),
    } })).status).toBe(202);
    expect(summaries[0]).toMatchObject({ origin: value, originCoverage: "verified", causalCoverage: "unavailable", complete: true });
    expect(Object.isFrozen(summaries[0]?.origin)).toBe(true);
    expect(Object.isFrozen(summaries[0]?.origin?.intent)).toBe(true);
  });

  it("leaves disabled and out-of-request annotation untouched", async () => {
    const sentinel = Object.defineProperty({}, "organizationId", { get() { throw new Error("must not inspect"); } });
    expect(timing.recordVerifiedEngineRequestOrigin("private-unparsed-header", sentinel as never)).toBe(false);
    const app = new Hono();
    app.use("*", timing.requestTiming({ slowMs: Infinity }));
    app.get("/disabled", c => {
      expect(timing.recordVerifiedEngineRequestOrigin("private-unparsed-header", sentinel as never)).toBe(false);
      return c.text("unchanged");
    });
    expect(await (await app.request("/disabled")).text()).toBe("unchanged");
  });

  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch"] as const)(
    "refuses an otherwise valid header with foreign %s", async field => {
      const value = origin({ mode: "boot-owner-v1", bootId: randomUUID(), writerEpoch: randomUUID() });
      const independent = { ...expected(value), [field]: field === "generation" ? 2 : randomUUID() };
      const { app, summaries } = observed();
      app.get("/engine", c => {
        expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(value), independent)).toBe(false);
        return c.text("unchanged");
      });
      expect((await app.request("/engine")).status).toBe(200);
      expect(summaries[0]).toMatchObject({ origin: null, originCoverage: "unverified" });
    });

  it("refuses a legacy/new-mode mismatch independently of matching IDs", async () => {
    const value = origin({ mode: "boot-owner-v1", bootId: randomUUID(), writerEpoch: randomUUID() });
    const { app, summaries } = observed();
    app.get("/engine", c => {
      expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(value), {
        ...expected(value), mode: "legacy", bootId: null, writerEpoch: null,
      })).toBe(false);
      return c.text("unchanged");
    });
    await app.request("/engine");
    expect(summaries[0]).toMatchObject({ origin: null, originCoverage: "unverified" });
  });

  it.each(["commandId", "conversationId", "turnId", "executionId", "operation"] as const)(
    "refuses a service/body mismatch for %s", async field => {
      const value = origin(), actual = expected(value);
      if (field === "operation") actual.operation = "commands.snapshot";
      else actual.intent = { ...value.intent, [field]: field === "commandId" ? randomUUID() : "other-identity" } as Wire.CloudAgentTurnRequestIntent;
      const { app, summaries } = observed();
      app.get("/engine", c => {
        expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(value), actual)).toBe(false);
        return c.text("unchanged");
      });
      await app.request("/engine");
      expect(summaries[0]).toMatchObject({ origin: null, originCoverage: "unverified" });
    });

  it.each([
    "missing", "malformed", "whitespace", "reordered", "oversized", "private-field", "invalid-operation", "invalid-boot",
    "invalid-uuid-version", "invalid-uuid-variant", "invalid-intent", "unsafe-generation",
  ])("matches the canonical wire parser for %s headers", async kind => {
    const value = origin(), canonical = Wire.encodeCloudAgentTurnRequestOrigin(value);
    const raw = kind === "missing" ? undefined : kind === "malformed" ? "{" : kind === "whitespace" ? ` ${canonical}` :
      kind === "reordered" ? JSON.stringify(Object.fromEntries(Object.entries(value).reverse())) :
      kind === "oversized" ? "x".repeat(Wire.CLOUD_AGENT_TURN_ORIGIN_MAX_BYTES + 1) :
      JSON.stringify({ ...value, ...(kind === "private-field" ? { token: "private-sentinel" } :
        kind === "invalid-operation" ? { operation: "private-operation" } :
        kind === "invalid-boot" ? { bootId: randomUUID() } :
        kind === "invalid-uuid-version" ? { spanId: "11111111-1111-0111-8111-111111111111" } :
        kind === "invalid-uuid-variant" ? { spanId: "11111111-1111-4111-7111-111111111111" } :
        kind === "invalid-intent" ? { intent: { kind: "command", commandId: randomUUID(), conversationId: "private text", turnId: "turn-1", executionId: null } } :
        { generation: Number.MAX_SAFE_INTEGER + 1 }) });
    expect(Wire.parseCloudAgentTurnRequestOriginHeader(raw)).toBeNull();
    const { app, summaries } = observed();
    app.get("/engine", c => {
      expect(timing.recordVerifiedEngineRequestOrigin(raw, expected(value))).toBe(false);
      return c.text("unchanged");
    });
    await app.request("/engine");
    expect(summaries[0]).toMatchObject({ origin: null, originCoverage: "unverified" });
    expect(JSON.stringify(summaries)).not.toContain("private-sentinel");
  });

  it.each(Wire.CloudAgentTurnRequestOperationSchema.options)("preserves valid standalone/wire operation %s", async operation => {
    const value = origin({ operation, producer: "background", intent: { kind: "none" } });
    const { app, summaries } = observed();
    app.get("/engine", c => {
      expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(value), expected(value))).toBe(true);
      return c.text("unchanged");
    });
    await app.request("/engine");
    expect(summaries[0]).toMatchObject({ origin: value, originCoverage: "verified", causalCoverage: "unavailable" });
  });

  it("binds the actual request claim without guessing a command", async () => {
    const value = origin({ operation: "commands.claim", intent: { kind: "claim", claimId: randomUUID(),
      conversationId: "conversation-1", executionId: "execution-1" } });
    const { app, summaries } = observed();
    app.get("/engine", c => {
      expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(value), expected(value))).toBe(true);
      return c.text("unchanged");
    });
    await app.request("/engine");
    expect(summaries[0]).toMatchObject({ origin: value, originCoverage: "verified" });
    expect(JSON.stringify(summaries[0]?.origin)).not.toContain("commandId");
  });

  it("keeps a claim without a known ID unverified", async () => {
    const value = origin({ operation: "commands.claim", intent: { kind: "claim", claimId: null,
      conversationId: "conversation-1", executionId: "execution-1" } });
    const { app, summaries } = observed();
    app.get("/engine", c => {
      expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(value), expected(value))).toBe(false);
      return c.text("unchanged");
    });
    await app.request("/engine");
    expect(summaries[0]).toMatchObject({ origin: null, originCoverage: "unverified" });
  });

  it("keeps identical annotations idempotent and conflicting spans permanently unknown", async () => {
    const value = origin(), second = { ...value, spanId: randomUUID() }, { app, summaries } = observed();
    app.get("/engine", c => {
      const raw = Wire.encodeCloudAgentTurnRequestOrigin(value);
      expect(timing.recordVerifiedEngineRequestOrigin(raw, expected(value))).toBe(true);
      expect(timing.recordVerifiedEngineRequestOrigin(raw, expected(value))).toBe(true);
      expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(second), expected(value))).toBe(false);
      expect(timing.recordVerifiedEngineRequestOrigin(raw, expected(value))).toBe(false);
      return c.text("unchanged");
    });
    await app.request("/engine");
    expect(summaries[0]).toMatchObject({ origin: null, originCoverage: "conflict" });
  });

  it("keeps concurrent authenticated scopes and late descendants separate", async () => {
    const first = origin(), second = origin(), { app, summaries } = observed();
    let release!: () => void, releaseLate!: () => void, late!: Promise<boolean>;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
    app.get("/first", async c => {
      expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(first), expected(first))).toBe(true);
      late = lateGate.then(() => timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(second), expected(second)));
      await blocked;
      return c.text("first");
    });
    app.get("/second", c => {
      expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(second), expected(second))).toBe(true);
      return c.text("second");
    });
    const pending = app.request("/first");
    try { expect((await app.request("/second")).status).toBe(200); } finally { release(); }
    await pending;
    releaseLate();
    expect(await late).toBe(false);
    expect(summaries.find(value => value.route === "/first")?.origin).toEqual(first);
    expect(summaries.find(value => value.route === "/second")?.origin).toEqual(second);
  });

  it("uses a bounded monotonic CP process interval independently of engine clock metadata", async () => {
    const value = origin(), { app, summaries } = observed();
    app.get("/engine", c => {
      expect(timing.recordVerifiedEngineRequestOrigin(Wire.encodeCloudAgentTurnRequestOrigin(value), expected(value))).toBe(true);
      return c.text("unchanged");
    });
    const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(1_000_000n).mockReturnValue(2_000_000n);
    try { await app.request("/engine"); } finally { clock.mockRestore(); }
    expect(summaries[0]).toMatchObject({ clockSource: "node-process-hrtime", startedAtUs: 1000, completedAtUs: 2000, clockCoverage: "complete" });
    expect(summaries[0]?.clockDomainId).not.toBe(value.clockId);
  });

  it("makes a regressed CP clock interval unavailable without changing HTTP", async () => {
    const { app, summaries } = observed();
    app.get("/engine", c => c.text("unchanged"));
    const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(2_000_000n).mockReturnValue(1_000_000n);
    try { expect((await app.request("/engine")).status).toBe(200); } finally { clock.mockRestore(); }
    expect(summaries[0]).toMatchObject({ clockCoverage: "unavailable", startedAtUs: null, completedAtUs: null });
  });
});
