import { randomUUID } from "node:crypto";

// Closed informational contract; neither a clock nor a span authorizes setup.
export const setupTimingSources = ["control_plane", "boat_transport", "setup", "attester_preflight", "attester_launch"];
export const setupTimingStages = ["admission", "provider_command", "admission_revoke", "bootstrap_probe", "ssh_transport", "supervisor",
  "template_verify", "image_preflight", "repository", "credential_projection", "image_launch", "engine_launch", "engine_readiness",
  "lock", "verify_tree", "qualify_engine", "run_setup", "publish_proof"];
const keys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
const integer = value => Number.isInteger(value) && value >= 0 && value <= 3_600_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseSetupTimings(value) {
  if (!keys(value, ["version", "clocks"]) || value.version !== 1 || !Array.isArray(value.clocks) || value.clocks.length > 5) return undefined;
  let count = 0;
  const ids = new Set(), sources = new Set();
  for (const clock of value.clocks) {
    if (!keys(clock, ["source", "clockId", "startedAt", "spans"]) || !setupTimingSources.includes(clock.source) || !uuid.test(clock.clockId) ||
      ids.has(clock.clockId) || sources.has(clock.source) || typeof clock.startedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(clock.startedAt) || !Number.isFinite(Date.parse(clock.startedAt)) || new Date(clock.startedAt).toISOString() !== clock.startedAt ||
      !Array.isArray(clock.spans) || (count += clock.spans.length) > 32) return undefined;
    ids.add(clock.clockId); sources.add(clock.source);
    for (const span of clock.spans) if (!keys(span, ["stage", "startMs", "endMs", "outcome"]) || !setupTimingStages.includes(span.stage) ||
      !integer(span.startMs) || !integer(span.endMs) || span.endMs < span.startMs || !["passed", "failed", "cancelled"].includes(span.outcome)) return undefined;
  }
  return Buffer.byteLength(JSON.stringify(value)) <= 8192 ? value : undefined;
}
export function mergeSetupTimings(...values) {
  const clocks = values.flatMap(value => parseSetupTimings(value)?.clocks ?? []);
  return clocks.length ? parseSetupTimings({ version: 1, clocks }) : undefined;
}
export function setupTimingClock(source) {
  const started = performance.now();
  const clock = { source, clockId: randomUUID(), startedAt: new Date().toISOString(), spans: [] };
  const elapsed = () => Math.min(3_600_000, Math.max(0, Math.round(performance.now() - started)));
  return {
    snapshot: () => ({ version: 1, clocks: [{ ...clock, spans: [...clock.spans] }] }),
    start(stage) {
      const startMs = elapsed();
      let ended = false;
      return (outcome = "passed") => {
        if (ended || clock.spans.length >= 32) return;
        ended = true;
        clock.spans.push({ stage, startMs, endMs: Math.max(startMs, elapsed()), outcome });
      };
    },
  };
}
