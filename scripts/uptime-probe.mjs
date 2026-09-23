#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// uptime-probe — external reachability check for deployed control planes
// ──────────────────────────────────────────────────────────
//
// Run by .github/workflows/uptime.yml. UPTIME_HEALTH_URLS lists comma-separated
// HTTPS `/healthz` URLs. A target fails when it stays unreachable, non-200,
// reports `ok: false`, or cannot read its cloud health across three attempts.
// Degraded cloud health is reported but does not fail the run: the in-service
// health alert worker already emails it, and this probe covers the case that
// worker cannot report — the service itself being down.
//
// Health responses are aggregate-only, so the summary carries no tenant data.
// ──────────────────────────────────────────────────────────

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ATTEMPTS = 3;

export function parseTargets(value) {
  const targets = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (targets.length > 16) throw new Error("UPTIME_HEALTH_URLS lists more than 16 targets");
  for (const target of targets) {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("UPTIME_HEALTH_URLS entries must be plain HTTPS URLs");
  }
  return targets;
}

/** One attempt: `failure` is null when the control plane answered healthy enough. */
const timedOut = (error) => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

export async function probeOnce(url, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(15_000);
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      headers: { accept: "application/json", "user-agent": "zeros-uptime-probe" },
      signal,
    });
  } catch (error) {
    return { failure: timedOut(error) ? "timeout" : "unreachable" };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { failure: `http_${response.status}` };
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { failure: timedOut(error) || signal.aborted ? "timeout" : "invalid_body" };
  }
  if (!body || body.ok !== true) return { failure: "not_ok" };
  const cloud = body.cloudWorkspaces;
  if (!cloud) return { failure: null, cloud: "disabled", reasons: [] };
  const reasons = Array.isArray(cloud.reasons) ? cloud.reasons.filter((reason) => typeof reason === "string") : [];
  if (cloud.operationalState === "unknown") return { failure: "cloud_health_unreadable", reasons };
  return { failure: null, cloud: String(cloud.operationalState), reasons };
}

export async function probe(url, { fetchImpl = fetch, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let result;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    result = await probeOnce(url, fetchImpl);
    if (!result.failure) return { url, attempts: attempt, ...result };
    if (attempt < ATTEMPTS) await pause(20_000);
  }
  return { url, attempts: ATTEMPTS, ...result };
}

async function main() {
  const targets = parseTargets(process.env.UPTIME_HEALTH_URLS);
  if (targets.length === 0) {
    console.log("uptime-probe: UPTIME_HEALTH_URLS is empty; nothing to check");
    return;
  }
  const results = await Promise.all(targets.map((url) => probe(url)));
  const lines = ["| Target | Result | Cloud | Reasons |", "| --- | --- | --- | --- |"];
  for (const result of results) {
    const host = new URL(result.url).host;
    lines.push(`| ${host} | ${result.failure ?? "up"} | ${result.cloud ?? "-"} | ${(result.reasons ?? []).join(", ") || "-"} |`);
    console.log(`uptime-probe: ${host} ${result.failure ?? "up"} cloud=${result.cloud ?? "-"} attempts=${result.attempts}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  if (results.some((result) => result.failure)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`uptime-probe: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
}
