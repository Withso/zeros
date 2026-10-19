// Bounded observations only. This schema is separate from every admission
// report, proof and stage clock; its reader is deployed before guest producers.
const readiness = ["total", "status_request", "sleep", "host_stopped", "boot_pending", "server_retryable",
  "status_timeout", "definitive_response"];
const transport = ["channel_open", "prepare", "host_key", "endpoint", "key_install", "ssh_command", "key_revoke", "channel_dispose"];
const qualification = ["module_load", "context_create", "identity", "actor_tools", "capture", "human_services",
  "census", "context_close", "launcher_view", "launcher_spawn", "launcher_retire", "launcher_drain"];
export const setupPerformanceStages = Object.freeze({
  readiness: Object.freeze(readiness), transport: Object.freeze([...readiness, ...transport]),
  helper: Object.freeze(["process_prelude", "request_parse", "materials", "total"]),
  attester_preflight: Object.freeze(qualification), attester_launch: Object.freeze([...qualification]),
  installer: Object.freeze(["base", "install_lock", "persistence", "cache_verify", "download", "archive_verify", "extract",
    "switch", "host_stop", "host_start", "helper", "total"]),
});
const MAX_MS = 3_600_000, MAX_COUNT = 4096;
const outcomes = ["passed", "failed", "cancelled"];
const keys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
const integer = (value, maximum, minimum = 0) => Number.isInteger(value) && value >= minimum && value <= maximum;

export function parseSetupPerformance(value) {
  try {
    if (!keys(value, ["version", "truncated", "groups"]) || value.version !== 1 || typeof value.truncated !== "boolean" ||
        !Array.isArray(value.groups) || value.groups.length > 6) return undefined;
    let entries = 0;
    const sources = new Set(), groups = [];
    for (const group of value.groups) {
      if (!keys(group, ["source", "stages"]) || !Object.hasOwn(setupPerformanceStages, group.source) || sources.has(group.source) ||
          !Array.isArray(group.stages) || group.stages.length === 0 || (entries += group.stages.length) > 64) return undefined;
      sources.add(group.source);
      const labels = new Set(), stages = [];
      for (const metric of group.stages) {
        if (!keys(metric, ["stage", "count", "totalMs", "maxMs", "lastOutcome"]) ||
            !setupPerformanceStages[group.source].includes(metric.stage) || labels.has(metric.stage) ||
            !integer(metric.count, MAX_COUNT, 1) || !integer(metric.totalMs, MAX_MS) || !integer(metric.maxMs, metric.totalMs) ||
            !outcomes.includes(metric.lastOutcome)) return undefined;
        labels.add(metric.stage);
        stages.push({ stage: metric.stage, count: metric.count, totalMs: metric.totalMs, maxMs: metric.maxMs, lastOutcome: metric.lastOutcome });
      }
      groups.push({ source: group.source, stages });
    }
    const parsed = { version: 1, truncated: value.truncated, groups };
    return Buffer.byteLength(JSON.stringify(parsed)) <= 8192 ? parsed : undefined;
  } catch { return undefined; }
}

export function selectSetupPerformance(value, permitted) {
  const parsed = parseSetupPerformance(value);
  return parsed?.groups.every(group => permitted.includes(group.source)) ? parsed : undefined;
}
export function mergeSetupPerformance(...values) {
  const groups = new Map();
  let truncated = false;
  for (const value of values) {
    const parsed = parseSetupPerformance(value);
    if (!parsed) continue;
    truncated ||= parsed.truncated;
    for (const group of parsed.groups) groups.set(group.source, group);
  }
  return groups.size ? parseSetupPerformance({ version: 1, truncated, groups: [...groups.values()] }) : undefined;
}
export function unwrapSetupPerformanceDiagnostic(value) {
  if (keys(value, ["schema", "diagnostic", "performance"]) && value.schema === "zeros.diagnostic/v2")
    return { diagnostic: value.diagnostic, performance: value.performance };
  return { diagnostic: value };
}
export function wrapSetupPerformanceDiagnostic(diagnostic, value) {
  const performance = parseSetupPerformance(value);
  return performance ? { schema: "zeros.diagnostic/v2", diagnostic, performance } : diagnostic;
}

export function setupPerformance(source, now = () => performance.now()) {
  const metrics = new Map();
  let truncated = false;
  const read = () => {
    try { const value = now(); if (Number.isFinite(value) && value >= 0) return value; } catch { /* Observation only. */ }
    truncated = true;
    return null;
  };
  const record = (stage, duration, outcome = "passed") => {
    if (!Object.hasOwn(setupPerformanceStages, source) || !setupPerformanceStages[source].includes(stage) ||
        !Number.isFinite(duration) || duration < 0 || !outcomes.includes(outcome)) { truncated = true; return; }
    const ms = Math.round(duration), prior = metrics.get(stage), count = (prior?.count ?? 0) + 1, total = (prior?.totalMs ?? 0) + ms;
    if (count > MAX_COUNT || total > MAX_MS || ms > MAX_MS) truncated = true;
    metrics.set(stage, { stage, count: Math.min(MAX_COUNT, count), totalMs: Math.min(MAX_MS, total),
      maxMs: Math.min(MAX_MS, Math.max(prior?.maxMs ?? 0, ms)), lastOutcome: outcome });
  };
  return {
    snapshot: () => ({ version: 1, truncated, groups: metrics.size ? [{ source, stages: [...metrics.values()].map(metric => ({ ...metric })) }] : [] }),
    record,
    start(stage) {
      const started = read();
      let ended = false;
      return (outcome = "passed") => {
        if (ended) return;
        ended = true;
        const end = read();
        if (started !== null && end !== null) record(stage, Math.max(0, end - started), outcome);
      };
    },
  };
}
export function notifySetupPerformance(observer, value) {
  try { const parsed = parseSetupPerformance(value); if (observer && parsed) observer(parsed); }
  catch { /* Optional observation cannot change qualification or cleanup. */ }
}
