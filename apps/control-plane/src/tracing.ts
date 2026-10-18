import { AsyncLocalStorage } from "node:async_hooks";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { RequestDatabaseTiming } from "./database-timing.js";
import { CloudProviderError } from "./cloud-workspaces/provider.js";

/** Every span attribute the control plane may emit, with its value type. A
 * closed list: identifiers, tokens, prompts, payloads, raw paths, query
 * strings and error messages never enter a span. */
export const TRACE_ATTRIBUTE_TYPES = Object.freeze({
  "http.request.method": "string",
  "http.route": "string",
  "http.response.status_code": "number",
  "error.type": "string",
  "zeros.db.span_kind": "string",
  "zeros.db.lock_purpose": "string",
  "zeros.db.failed": "boolean",
  "zeros.boat.route": "string",
} as const);

/** Health probes run every few seconds and carry no user work. */
export const UNTRACED_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);

const METHOD = /^[A-Z]{3,7}$/;
const ERROR_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const BOAT_PATH = /^\/[a-zA-Z0-9/_-]+(?:\?[a-zA-Z0-9_=&%.-]+)?$/;
const BOAT_STATIC_SEGMENT = /^[a-z][a-z-]{0,31}$/;
const PROVIDER_ERROR_CODE = /^provider_[a-z_]{1,48}$/;

export function traceAttributes(input: Readonly<Record<string, unknown>>): Attributes {
  const attributes: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(TRACE_ATTRIBUTE_TYPES) as (keyof typeof TRACE_ATTRIBUTE_TYPES)[]) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (TRACE_ATTRIBUTE_TYPES[key] === "string") {
      if (typeof value === "string" && value.length >= 1 && value.length <= 256 &&
          (key !== "error.type" || ERROR_TYPE.test(value))) attributes[key] = value;
    } else if (TRACE_ATTRIBUTE_TYPES[key] === "number") {
      if (typeof value === "number" && Number.isSafeInteger(value)) attributes[key] = value;
    } else if (typeof value === "boolean") attributes[key] = value;
  }
  return attributes;
}

export type TraceParent = Readonly<{ traceId: string; spanId: string; sampled: boolean }>;

export function parseTraceparent(value: unknown): TraceParent | null {
  const match = typeof value === "string" ? TRACEPARENT.exec(value) : null;
  if (!match) return null;
  const [, traceId = "", spanId = "", flags = ""] = match;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function boatRouteTemplate(path: string): string {
  if (!BOAT_PATH.test(path) || path.startsWith("//") || path.includes("..")) return "invalid";
  const [pathname = ""] = path.split("?");
  const segments = pathname.split("/")
    .filter(segment => segment.length > 0)
    .map(segment => (BOAT_STATIC_SEGMENT.test(segment) ? segment : "{id}"));
  return "/" + segments.join("/");
}

export type ControlPlaneTracingOptions = Readonly<{
  exporter: SpanExporter;
  /** Share of requests without a remote parent that are recorded, 0..1. */
  sampleRatio: number;
  processRole: "api" | "worker" | "realtime" | "combined";
  deploymentChannel?: "development" | "alpha" | "beta" | "production";
  /** "simple" exports each span when it ends (tests); default "batch". */
  processor?: "batch" | "simple";
}>;

let state: { provider: TracerProvider; tracer: Tracer } | undefined;

export function configureControlPlaneTracing(options: ControlPlaneTracingOptions): void {
  if (state) throw new Error("Control-plane tracing is already configured");
  const { sampleRatio } = options;
  if (!(Number.isFinite(sampleRatio) && sampleRatio >= 0 && sampleRatio <= 1))
    throw new RangeError("Invalid trace sample ratio");
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": "zeros-control-plane",
      "zeros.process_role": options.processRole,
      ...(options.deploymentChannel ? { "deployment.environment.name": options.deploymentChannel } : {}),
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) }),
    spanLimits: { attributeCountLimit: 16, attributeValueLengthLimit: 256, eventCountLimit: 0, linkCountLimit: 0 },
    spanProcessors: [options.processor === "simple"
      ? new SimpleSpanProcessor({ exporter: options.exporter })
      : new BatchSpanProcessor({
          exporter: options.exporter, maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 2000, exportTimeoutMillis: 5000,
        })],
  });
  state = { provider, tracer: provider.getTracer("zeros-control-plane") };
}

/** Stops new requests from tracing at once, then waits at most `timeoutMs`
 * for queued spans to export. A stuck exporter cannot hold shutdown open. */
export async function shutdownControlPlaneTracing(timeoutMs = 2_000): Promise<void> {
  const current = state;
  if (!current) return;
  state = undefined;
  await Promise.race([
    current.provider.shutdown().catch(() => {}),
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

export function createOtlpTraceExporter(url: string): SpanExporter {
  return new OTLPTraceExporter({ url, timeoutMillis: 5_000 });
}

const requestSpans = new AsyncLocalStorage<{ context: Context; startMs: number; recording: boolean }>();

export const tracingMiddleware: MiddlewareHandler = async (c, next) => {
  const current = state;
  if (!current || UNTRACED_PATHS.has(c.req.path)) return next();
  const method = METHOD.test(c.req.method) ? c.req.method : "OTHER";
  const parsed = parseTraceparent(c.req.header("traceparent"));
  const parentContext = parsed
    ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: parsed.traceId,
        spanId: parsed.spanId,
        traceFlags: parsed.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
        isRemote: true,
      })
    : ROOT_CONTEXT;
  const startMs = performance.timeOrigin + performance.now();
  const span = current.tracer.startSpan(
    method,
    { kind: SpanKind.SERVER, startTime: startMs, attributes: traceAttributes({ "http.request.method": method }) },
    parentContext,
  );
  // Runs even when unsampled, so child spans inherit the sampling decision.
  try {
    await requestSpans.run(
      { context: trace.setSpan(parentContext, span), startMs, recording: span.isRecording() },
      () => next(),
    );
  } catch (error) {
    const route = routePath(c) || "unmatched";
    span.updateName(`${method} ${route}`);
    span.setAttributes(traceAttributes({ "http.route": route, "error.type": "exception" }));
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    throw error;
  }
  const route = routePath(c) || "unmatched";
  span.updateName(`${method} ${route}`);
  span.setAttributes(traceAttributes({
    "http.route": route,
    ...(c.finalized ? { "http.response.status_code": c.res.status } : { "error.type": "exception" }),
  }));
  if (!c.finalized || c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
};

/** Database work becomes child spans of the request that performed it. */
export function observeDatabaseTiming(timing: RequestDatabaseTiming): void {
  try {
    const current = state;
    const store = requestSpans.getStore();
    if (!current || !store?.recording) return;
    for (const span of timing.spans) {
      const start = store.startMs + span.offsetMs;
      const child = current.tracer.startSpan(
        `db ${span.kind}`,
        {
          kind: SpanKind.CLIENT,
          startTime: start,
          attributes: traceAttributes({
            "zeros.db.span_kind": span.kind,
            ...(span.purpose !== null ? { "zeros.db.lock_purpose": span.purpose } : {}),
            ...(span.failed !== null ? { "zeros.db.failed": span.failed } : {}),
          }),
        },
        store.context,
      );
      if (span.failed === true) child.setStatus({ code: SpanStatusCode.ERROR });
      child.end(start + span.durationMs);
    }
  } catch {
    /* Tracing never breaks a request. */
  }
}

export type ProviderSpan = { status(code: number): void; end(error?: unknown): void };

/** A client span for one Boat API call, or null when it would not be recorded. */
export function startBoatSpan(method: string, path: string): ProviderSpan | null {
  const current = state;
  if (!current) return null;
  const safeMethod = METHOD.test(method) ? method : "OTHER";
  const route = boatRouteTemplate(path);
  const span = current.tracer.startSpan(
    `boat ${safeMethod} ${route}`,
    {
      kind: SpanKind.CLIENT,
      attributes: traceAttributes({ "http.request.method": safeMethod, "zeros.boat.route": route }),
    },
    requestSpans.getStore()?.context ?? ROOT_CONTEXT,
  );
  if (!span.isRecording()) {
    span.end();
    return null;
  }
  let ended = false;
  let responseStatus: number | undefined;
  return {
    status(code) {
      if (ended) return;
      responseStatus = code;
      span.setAttributes(traceAttributes({ "http.response.status_code": code }));
    },
    end(error) {
      if (ended) return;
      ended = true;
      if (error !== undefined) {
        const errorType = error instanceof CloudProviderError && typeof error.code === "string" &&
          PROVIDER_ERROR_CODE.test(error.code) ? error.code : "exception";
        span.setAttributes(traceAttributes({ "error.type": errorType }));
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else if (responseStatus !== undefined && responseStatus >= 400) {
        span.setAttributes(traceAttributes({ "error.type": "http_status" }));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    },
  };
}
