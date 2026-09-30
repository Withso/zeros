import fs from "node:fs";
import { expect, it } from "vitest";

// A failed native agent test reports only fixed phase/check names. An unknown
// one is dropped, which hid where the MCP rotation check failed.
it("reports every phase and check the native qualification script can produce", () => {
  const monitor = fs.readFileSync("scripts/dev-environment/hosted-agents.mjs", "utf8");
  const script = fs.readFileSync("scripts/cloud-workspace-validation/sandbox/qualify-cloud-agent.ts", "utf8");
  const phases = new Set([...monitor.match(/const phases = \[([\s\S]*?)\];/)![1]!.matchAll(/"([^"]+)"/g)].map(match => match[1]));
  const known = new Set([...monitor.matchAll(/"([A-Za-z]+)"/g)].map(match => match[1]));
  const scriptPhases = [...new Set([...script.matchAll(/phase ?= ?"([^"]+)"/g)].map(match => match[1]!))];
  const scriptChecks = [...new Set([...script.matchAll(/checks\.push\(([^)]*)\)/g)].flatMap(match => [...match[1]!.matchAll(/"([A-Za-z]+)"/g)].map(name => name[1]!)))];
  expect(scriptPhases.length).toBeGreaterThan(10);
  expect(scriptPhases.filter(phase => !phases.has(phase))).toEqual([]);
  expect(scriptChecks.filter(check => !known.has(check))).toEqual([]);
});
