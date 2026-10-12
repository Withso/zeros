#!/usr/bin/env node
// Optional integration check against the real, pinned Renovate matcher. Kept
// outside ordinary CI installs; see the operator guide for the isolated install.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { invariant } from "./contracts.mjs";

const directory = resolve(
  process.argv[2] ?? ".context/renovate-validator/node_modules/renovate",
);
invariant(
  JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version ===
    "44.151.3",
  "Use the documented pinned Renovate version for this handoff check.",
);
const { applyPackageRules } = await import(
  pathToFileURL(join(directory, "dist/util/package-rules/index.js")).href
);
const config = JSON.parse(readFileSync("renovate.json", "utf8"));
const scenarios = [
  ...["@anthropic-ai/claude-agent-sdk", "@openai/codex", "@cursor/sdk"].flatMap(
    (name) =>
      [false, true].map((alert) => ({
        name,
        file: "package.json",
        alert,
        ignored: true,
      })),
  ),
  {
    name: "@openai/codex",
    file: "apps/control-plane/package.json",
    alert: true,
    ignored: true,
  },
  { name: "lodash", file: "package.json", alert: true, ignored: false },
  { name: "semver", file: "package.json", alert: true, ignored: false },
  {
    name: "@openai/codex",
    file: "fixture/package.json",
    alert: true,
    ignored: false,
  },
];
for (const scenario of scenarios) {
  const result = await applyPackageRules(
    {
      ...config,
      manager: "npm",
      depName: scenario.name,
      packageName: scenario.name,
      packageFile: scenario.file,
      ignoreDeps: [],
      isVulnerabilityAlert: scenario.alert,
      ...(scenario.alert ? { force: config.vulnerabilityAlerts } : {}),
    },
    "pre-lookup",
  );
  invariant(
    result.ignoreDeps.includes(scenario.name) === scenario.ignored,
    "Renovate ownership scope changed.",
  );
  if (scenario.alert && !scenario.ignored)
    invariant(
      result.enabled === true,
      "An unrelated advisory fix was suppressed.",
    );
}
// This is the actual dependency-fetch early return, not a second implementation
// of Renovate's precedence. Pinning the package makes a changed boundary explicit.
const fetchSource = readFileSync(
  join(directory, "dist/workers/repository/process/fetch.js"),
  "utf8",
);
invariant(
  fetchSource.includes("if (depConfig.ignoreDeps.includes(depName))") &&
    fetchSource.indexOf("if (depConfig.ignoreDeps.includes(depName))") <
      fetchSource.indexOf("if (depConfig.enabled === false"),
  "Renovate's hard-ignore boundary changed; requalify handoff.",
);
console.log(
  `Renovate 44.151.3: ${scenarios.length} actual precedence/scope scenarios passed. No repository, branch or PR writes performed.`,
);
