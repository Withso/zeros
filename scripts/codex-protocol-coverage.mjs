#!/usr/bin/env node
// Keep every method in the pinned Codex app-server bindings deliberately
// classified without conflating generated protocol availability with a Zeros
// product feature. A regeneration must update this manifest in the same PR.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CODEX_ADAPTER_DIR = join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src",
  "engine",
  "agents",
  "adapters",
  "codex",
);
const GENERATED_DIR = join(CODEX_ADAPTER_DIR, "generated");
const COVERAGE_MANIFEST = join(CODEX_ADAPTER_DIR, "protocol-coverage.json");

const SECTION_STATES = {
  "client request": new Set(["handled", "generated-only"]),
  "server request": new Set(["handled", "provider-conditional"]),
  "server notification": new Set(["canonical", "handled", "forwarded"]),
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extractCodexMethods(source, label = "generated source") {
  const methods = [];
  const seen = new Set();
  const duplicates = new Set();
  const pattern = /"method"\s*:\s*"([^"]+)"/g;

  for (const match of source.matchAll(pattern)) {
    const method = match[1];
    if (seen.has(method)) duplicates.add(method);
    else {
      seen.add(method);
      methods.push(method);
    }
  }
  if (methods.length === 0) {
    throw new Error(`no Codex method discriminants found in ${label}`);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `duplicate Codex method discriminant(s) in ${label}: ${[
        ...duplicates,
      ].join(", ")}`,
    );
  }
  return methods;
}

function validateSection({ errors, generatedMethods, label, section }) {
  if (!isRecord(section)) {
    errors.push(`${label} coverage must be an object`);
    return {};
  }

  const allowedStates = SECTION_STATES[label];
  const generated = new Set(generatedMethods);
  const classified = new Map();
  const stale = new Set();
  const duplicates = new Set();
  const counts = {};

  for (const [state, methods] of Object.entries(section)) {
    if (!allowedStates?.has(state)) {
      errors.push(`unknown ${label} classification ${JSON.stringify(state)}`);
      continue;
    }
    if (!Array.isArray(methods)) {
      errors.push(`${label} classification ${state} must be an array`);
      continue;
    }
    counts[state] = methods.length;
    for (const method of methods) {
      if (typeof method !== "string" || method.length === 0) {
        errors.push(`${label} classification ${state} contains a non-method`);
        continue;
      }
      if (!generated.has(method)) stale.add(method);
      if (classified.has(method)) duplicates.add(method);
      else classified.set(method, state);
    }
  }

  const missing = generatedMethods.filter((method) => !classified.has(method));
  if (missing.length > 0) {
    errors.push(`unclassified ${label}(s): ${missing.join(", ")}`);
  }
  if (stale.size > 0) {
    errors.push(`stale ${label} classification(s): ${[...stale].join(", ")}`);
  }
  if (duplicates.size > 0) {
    errors.push(
      `duplicate ${label} classification(s): ${[...duplicates].join(", ")}`,
    );
  }

  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function validateCodexProtocolCoverage({
  manifest,
  pinnedVersion,
  clientRequests,
  serverRequests,
  serverNotifications,
}) {
  const errors = [];
  if (!isRecord(manifest)) {
    throw new Error("Codex protocol coverage manifest must be an object");
  }
  if (manifest.schemaVersion !== 1) {
    errors.push(
      `unsupported coverage schema version ${JSON.stringify(manifest.schemaVersion)}; expected 1`,
    );
  }
  if (manifest.codexProtocolVersion !== pinnedVersion) {
    errors.push(
      `coverage version ${JSON.stringify(manifest.codexProtocolVersion)} does not match pin ${JSON.stringify(pinnedVersion)}`,
    );
  }

  const clientRequestCounts = validateSection({
    errors,
    generatedMethods: clientRequests,
    label: "client request",
    section: manifest.clientRequests,
  });
  const serverRequestCounts = validateSection({
    errors,
    generatedMethods: serverRequests,
    label: "server request",
    section: manifest.serverRequests,
  });
  const serverNotificationCounts = validateSection({
    errors,
    generatedMethods: serverNotifications,
    label: "server notification",
    section: manifest.serverNotifications,
  });

  if (errors.length > 0) {
    throw new Error(
      `Codex protocol coverage is invalid:\n- ${errors.join("\n- ")}`,
    );
  }
  return {
    clientRequests: clientRequestCounts,
    serverRequests: serverRequestCounts,
    serverNotifications: serverNotificationCounts,
    total:
      clientRequests.length +
      serverRequests.length +
      serverNotifications.length,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} could not be read from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([state, count]) => `${state}=${count}`)
    .join(", ");
}

export function runCodexProtocolCoverageCheck() {
  const packageJson = readJson(join(REPO_ROOT, "package.json"), "package.json");
  const manifest = readJson(COVERAGE_MANIFEST, "coverage manifest");
  const pinnedVersion = packageJson.codexProtocolVersion;
  if (typeof pinnedVersion !== "string" || pinnedVersion.length === 0) {
    throw new Error(
      "package.json#codexProtocolVersion must be a non-empty string",
    );
  }

  const clientRequests = extractCodexMethods(
    readFileSync(join(GENERATED_DIR, "ClientRequest.ts"), "utf8"),
    "generated/ClientRequest.ts",
  );
  const serverRequests = extractCodexMethods(
    readFileSync(join(GENERATED_DIR, "ServerRequest.ts"), "utf8"),
    "generated/ServerRequest.ts",
  );
  const serverNotifications = extractCodexMethods(
    readFileSync(join(GENERATED_DIR, "ServerNotificationEnvelope.ts"), "utf8"),
    "generated/ServerNotificationEnvelope.ts",
  );

  const report = validateCodexProtocolCoverage({
    manifest,
    pinnedVersion,
    clientRequests,
    serverRequests,
    serverNotifications,
  });
  console.log(
    `✓ check:codex-coverage — ${report.total} protocol methods classified for ${pinnedVersion}`,
  );
  console.log(`  client requests: ${formatCounts(report.clientRequests)}`);
  console.log(`  server requests: ${formatCounts(report.serverRequests)}`);
  console.log(
    `  server notifications: ${formatCounts(report.serverNotifications)}`,
  );
  return report;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runCodexProtocolCoverageCheck();
  } catch (error) {
    console.error(
      `✖ check:codex-coverage — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
