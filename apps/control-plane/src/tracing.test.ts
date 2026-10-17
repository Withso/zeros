import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { BoatApiClient } from "./cloud-workspaces/boat-client.js";
import { recordTransactionTiming, requestTiming } from "./request-timing.js";
import {
  boatRouteTemplate,
  configureControlPlaneTracing,
  observeDatabaseTiming,
  parseTraceparent,
  shutdownControlPlaneTracing,
  startBoatSpan,
  TRACE_ATTRIBUTE_TYPES,
  traceAttributes,
  tracingMiddleware,
} from "./tracing.js";

const PARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const UNSAMPLED = PARENT.replace(/-01$/, "-00");
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const FORBIDDEN = /abc123|bx_23456789|boat-test-api-key-0001|secret-value-1234/;

let status = 200;
const boat = new BoatApiClient({
  apiKey: "boat-test-api-key-0001",
  timeoutMs: 1000,
  fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status })) as unknown as typeof fetch,
});

let exporter: InMemorySpanExporter;

beforeEach(() => {
  status = 200;
  exporter = new InMemorySpanExporter();
  configureControlPlaneTracing({ exporter, sampleRatio: 1, processRole: "api", processor: "simple" });
});

afterEach(async () => {
  await shutdownControlPlaneTracing();
});

function app(): Hono {
  const hono = new Hono();
  hono.use("*", tracingMiddleware);
  hono.use("*", requestTiming({ slowMs: 60_000, timingObserver: observeDatabaseTiming }));
  hono.get("/v1/things/:thing", c => c.json({ ok: true }));
  hono.get("/v1/db/:thing", async c => {
    await new Promise(resolve => setTimeout(resolve, 15));
    recordTransactionTiming(3, 10);
    return c.json({ ok: true });
  });
  hono.get("/v1/boat/:thing", async c => {
    await boat.request("/sandboxes/bx_23456789");
    return c.json({ ok: true });
  });
  hono.get("/v1/fail/:thing", () => {
    throw new Error("secret-value-1234");
  });
  hono.get("/healthz", c => c.json({ ok: true }));
  return hono;
}

const toMs = (time: [number, number]) => time[0] * 1000 + time[1] / 1e6;
const named = (spans: ReadableSpan[], name: string) => spans.find(span => span.name === name);

describe("control-plane tracing", () => {
  it("records one server span that continues a sampled remote parent", async () => {
    const response = await app().request("/v1/things/abc123", { headers: { traceparent: PARENT } });
    expect(response.status).toBe(200);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span!.kind).toBe(SpanKind.SERVER);
    expect(span!.spanContext().traceId).toBe(TRACE_ID);
    expect(span!.parentSpanContext?.spanId).toBe("b7ad6b7169203331");
    expect(span!.name).toBe("GET /v1/things/:thing");
    expect(span!.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/v1/things/:thing",
      "http.response.status_code": 200,
    });
  });

  it("records nothing for an unsampled remote parent", async () => {
    const response = await app().request("/v1/things/abc123", { headers: { traceparent: UNSAMPLED } });
    expect(response.status).toBe(200);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("starts a root span without a header at ratio 1 and none at ratio 0", async () => {
    await app().request("/v1/things/abc123");
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.parentSpanContext).toBeUndefined();
    expect(spans[0]!.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    await shutdownControlPlaneTracing();
    exporter = new InMemorySpanExporter();
    configureControlPlaneTracing({ exporter, sampleRatio: 0, processRole: "api", processor: "simple" });
    await app().request("/v1/things/abc123");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("ignores invalid traceparent headers instead of trusting them", async () => {
    const invalid = [
      "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01",
      "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      "00-00000000000000000000000000000000-b7ad6b7169203331-01",
      `${PARENT}0`,
      `${PARENT}-x`,
    ];
    for (const header of invalid) {
      exporter.reset();
      const response = await app().request("/v1/things/abc123", { headers: { traceparent: header } });
      expect(response.status).toBe(200);
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.parentSpanContext).toBeUndefined();
      expect(spans[0]!.spanContext().traceId).not.toBe(header.slice(3, 35));
    }
  });

  it("parents database spans under the server span on the same trace", async () => {
    const response = await app().request("/v1/db/x", { headers: { traceparent: PARENT } });
    expect(response.status).toBe(200);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    const server = spans.find(span => span.kind === SpanKind.SERVER)!;
    const pool = named(spans, "db pool-wait")!;
    const transaction = named(spans, "db transaction")!;
    for (const child of [pool, transaction]) {
      expect(child.kind).toBe(SpanKind.CLIENT);
      expect(child.spanContext().traceId).toBe(TRACE_ID);
      expect(child.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
      expect(toMs(child.startTime)).toBeGreaterThanOrEqual(toMs(server.startTime));
      expect(toMs(child.endTime)).toBeLessThanOrEqual(toMs(server.endTime) + 5);
    }
    expect(transaction.attributes).toEqual({ "zeros.db.span_kind": "transaction" });
    expect(pool.attributes).toEqual({ "zeros.db.span_kind": "pool-wait", "zeros.db.failed": false });
  });

  it("records no database spans for an unsampled request", async () => {
    const response = await app().request("/v1/db/x", { headers: { traceparent: UNSAMPLED } });
    expect(response.status).toBe(200);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("traces a Boat call as a client span under the request", async () => {
    const response = await app().request("/v1/boat/x", { headers: { traceparent: PARENT } });
    expect(response.status).toBe(200);
    const spans = exporter.getFinishedSpans();
    const server = spans.find(span => span.kind === SpanKind.SERVER)!;
    const call = named(spans, "boat GET /sandboxes/{id}")!;
    expect(call.kind).toBe(SpanKind.CLIENT);
    expect(call.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(call.attributes).toEqual({
      "http.request.method": "GET",
      "zeros.boat.route": "/sandboxes/{id}",
      "http.response.status_code": 200,
    });
    expect(call.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("marks a failed Boat call with its status and provider error code", async () => {
    status = 429;
    const response = await app().request("/v1/boat/x", { headers: { traceparent: PARENT } });
    expect(response.status).toBe(500);
    const call = named(exporter.getFinishedSpans(), "boat GET /sandboxes/{id}")!;
    expect(call.attributes).toEqual({
      "http.request.method": "GET",
      "zeros.boat.route": "/sandboxes/{id}",
      "http.response.status_code": 429,
      "error.type": "provider_rate_limited",
    });
    expect(call.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("traces a Boat call made outside a request only while sampled", async () => {
    expect(await boat.request("/sandboxes/bx_23456789")).toEqual({ ok: true });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.kind).toBe(SpanKind.CLIENT);
    expect(spans[0]!.parentSpanContext).toBeUndefined();
    await shutdownControlPlaneTracing();
    exporter = new InMemorySpanExporter();
    configureControlPlaneTracing({ exporter, sampleRatio: 0, processRole: "api", processor: "simple" });
    expect(await boat.request("/sandboxes/bx_23456789")).toEqual({ ok: true });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await shutdownControlPlaneTracing();
    expect(startBoatSpan("GET", "/x")).toBeNull();
    expect(await boat.request("/sandboxes/bx_23456789")).toEqual({ ok: true });
  });

  it("records a handler error without its message", async () => {
    const response = await app().request("/v1/fail/x", { headers: { traceparent: PARENT } });
    expect(response.status).toBe(500);
    const spans = exporter.getFinishedSpans();
    const server = spans.find(span => span.kind === SpanKind.SERVER)!;
    expect(server.status.code).toBe(SpanStatusCode.ERROR);
    expect(server.attributes["http.response.status_code"]).toBe(500);
    for (const span of spans) {
      expect(span.events).toHaveLength(0);
      expect(span.name).not.toContain("secret-value-1234");
      for (const value of Object.values(span.attributes)) expect(String(value)).not.toContain("secret-value-1234");
    }
  });

  it("does not trace health probes", async () => {
    const response = await app().request("/healthz", { headers: { traceparent: PARENT } });
    expect(response.status).toBe(200);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("emits only allow-listed attribute keys and no identifiers, tokens or messages", async () => {
    const spans: ReadableSpan[] = [];
    const collect = async (path: string) => {
      exporter.reset();
      await app().request(path, { headers: { traceparent: PARENT } });
      spans.push(...exporter.getFinishedSpans());
    };
    await collect("/v1/things/abc123");
    await collect("/v1/db/x");
    await collect("/v1/boat/x");
    status = 429;
    await collect("/v1/boat/x");
    status = 200;
    await collect("/v1/fail/x");
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.name).not.toMatch(FORBIDDEN);
      for (const [key, value] of Object.entries(span.attributes)) {
        expect(Object.hasOwn(TRACE_ATTRIBUTE_TYPES, key)).toBe(true);
        expect(String(value)).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("keeps only allow-listed attributes with their declared types", () => {
    expect(
      traceAttributes({
        authorization: "Bearer x",
        "http.route": "/a",
        "http.request.method": 5,
        "http.response.status_code": 1.5,
        "error.type": "Not Allowed",
        "zeros.db.failed": "yes",
        "zeros.boat.route": "x".repeat(257),
      }),
    ).toEqual({ "http.route": "/a" });
  });

  it("parses only canonical version-00 traceparent values", () => {
    expect(parseTraceparent(PARENT)).toEqual({ traceId: TRACE_ID, spanId: "b7ad6b7169203331", sampled: true });
    expect(parseTraceparent(UNSAMPLED)?.sampled).toBe(false);
    expect(parseTraceparent(PARENT.replace(/-01$/, "-03"))?.sampled).toBe(true);
    const rejected: unknown[] = [
      undefined,
      42,
      "",
      PARENT.toUpperCase(),
      `ff${PARENT.slice(2)}`,
      "00-00000000000000000000000000000000-b7ad6b7169203331-01",
      "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
      PARENT.slice(0, 54),
      `${PARENT}0`,
    ];
    for (const value of rejected) expect(parseTraceparent(value)).toBeNull();
  });

  it("maps Boat paths to route templates", () => {
    expect(boatRouteTemplate("/sandboxes/bx_23456789/fork")).toBe("/sandboxes/{id}/fork");
    expect(boatRouteTemplate("/sandboxes?limit=100&cursor=abc")).toBe("/sandboxes");
    expect(boatRouteTemplate("/snapshots/snap_Ab12/tree")).toBe("/snapshots/{id}/tree");
    expect(boatRouteTemplate("/a//b")).toBe("/a/b");
    expect(boatRouteTemplate("/sandboxes/../x")).toBe("invalid");
    expect(boatRouteTemplate("//x")).toBe("invalid");
    expect(boatRouteTemplate("no-slash")).toBe("invalid");
  });

  it("configures once at a time and validates the sample ratio", async () => {
    expect(() => configureControlPlaneTracing({ exporter, sampleRatio: 1, processRole: "api" })).toThrow(
      "Control-plane tracing is already configured",
    );
    await shutdownControlPlaneTracing();
    configureControlPlaneTracing({ exporter: new InMemorySpanExporter(), sampleRatio: 1, processRole: "api", processor: "simple" });
    await shutdownControlPlaneTracing();
    for (const sampleRatio of [Number.NaN, -0.1, 1.1]) {
      expect(() => configureControlPlaneTracing({ exporter, sampleRatio, processRole: "api" })).toThrow(RangeError);
    }
  });

  it("resolves shutdown within its timeout when the exporter never settles", async () => {
    await shutdownControlPlaneTracing();
    configureControlPlaneTracing({
      exporter: { export: (_spans, done) => done({ code: 0 }), shutdown: () => new Promise<void>(() => {}) },
      sampleRatio: 1,
      processRole: "api",
    });
    await expect(shutdownControlPlaneTracing(50)).resolves.toBeUndefined();
  });

  it("answers normally and records nothing once tracing is shut down", async () => {
    await shutdownControlPlaneTracing();
    const unconfigured = new InMemorySpanExporter();
    const response = await app().request("/v1/db/x", { headers: { traceparent: PARENT } });
    expect(response.status).toBe(200);
    expect(unconfigured.getFinishedSpans()).toHaveLength(0);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
