import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, PROVIDERS, REPOSITORY } from "./config.mjs";
import { invariant, plain, sha, stableVersion } from "./contracts.mjs";
import { cleanProcessEnv } from "./environment.mjs";

// Fixed independent gates. A failing gate never suppresses the remaining results.
export const GATES = Object.freeze([
  "check:runtime-pins",
  "check:codex-pin",
  "check:codex-coverage",
  "models:verify",
  "check:cursor-asar",
  "check:licenses",
  "check:packaging-paths",
  "claude:smoke",
  "codex:smoke",
  "cursor:smoke",
  "cursor:smoke:electron",
  "test:adapters",
  "agent-runtime:surfaces",
]);

export function validateReport(report) {
  invariant(
    plain(report) &&
      report.schema === 1 &&
      sha(report.head) &&
      (report.testedHead === null || sha(report.testedHead)),
    "Invalid runtime report commits.",
  );
  invariant(
    (report.provider == null || Object.hasOwn(PROVIDERS, report.provider)) &&
      (report.version == null || stableVersion(report.version)),
    "Invalid reported working pin.",
  );
  invariant(
    Array.isArray(report.gates) &&
      report.gates.length <= 32 &&
      Array.isArray(report.changes) &&
      report.changes.length <= 10_000,
    "Invalid runtime report inventory.",
  );
  const names = new Set();
  for (const gate of report.gates) {
    invariant(
      plain(gate) &&
        typeof gate.name === "string" &&
        /^[a-z][a-z0-9:-]{0,79}$/.test(gate.name) &&
        !names.has(gate.name) &&
        ["passed", "failed", "incomplete"].includes(gate.status),
      "Invalid runtime gate.",
    );
    invariant(
      gate.exitCode === null ||
        (Number.isInteger(gate.exitCode) &&
          gate.exitCode >= 0 &&
          gate.exitCode <= 255),
      "Invalid gate exit code.",
    );
    invariant(
      gate.status === "passed" ? gate.exitCode === 0 : gate.exitCode !== 0,
      "Gate verdict disagrees with its exit code.",
    );
    names.add(gate.name);
  }
  for (const change of report.changes)
    invariant(
      plain(change) &&
        ["added", "removed", "changed"].includes(change.kind) &&
        typeof change.subject === "string" &&
        change.subject.length <= 2000 &&
        (change.disposition == null ||
          [
            "implemented",
            "sdk-owned",
            "preserved-generically",
            "generated-only",
            "intentionally-deferred",
            "upstream-blocked",
          ].includes(change.disposition)),
      "Invalid surface review change.",
    );
  invariant(
    report.summary == null ||
      (typeof report.summary === "string" && report.summary.length <= 2000),
    "Invalid report summary.",
  );
  invariant(
    Buffer.byteLength(JSON.stringify(report)) <= LIMITS.report,
    "Runtime report exceeds its bound.",
  );
  return report;
}

export function validateQualification(
  report,
  { run, head, testedHead, base, pr },
) {
  validateReport(report);
  invariant(
    report.repository === REPOSITORY &&
      report.runId === run.id &&
      report.attempt === run.run_attempt &&
      report.head === head &&
      report.testedHead === testedHead &&
      report.base === base &&
      report.pr === pr &&
      report.event === run.event,
    "Qualification report provenance mismatch.",
  );
  invariant(
    report.gates.length === GATES.length &&
      report.gates.every((gate, index) => gate.name === GATES[index]),
    "Qualification omitted or reordered a required gate.",
  );
  return report;
}

export async function qualify({
  root,
  output,
  head,
  testedHead,
  base,
  pr = null,
  runId = null,
  attempt = null,
  event = "local",
  setup = true,
  execute = spawnSync,
  inspect,
  environment = process.env,
}) {
  invariant(
    sha(head) && sha(testedHead) && sha(base),
    "Qualification requires immutable source/tested/base commits.",
  );
  mkdirSync(output, { recursive: true });
  const gates = [],
    report = {
      schema: 1,
      repository: REPOSITORY,
      head,
      testedHead,
      base,
      pr,
      runId,
      attempt,
      event,
      gates,
      changes: [],
      summary:
        "Independent runtime qualification; publication, account discovery and live platform qualification are separate evidence.",
    };
  const env = {
    ...cleanProcessEnv(environment),
    ...(environment.DISPLAY ? { DISPLAY: environment.DISPLAY } : {}),
  };
  for (const name of GATES) {
    let gate = { name, status: "incomplete", exitCode: null };
    if (setup) {
      if (name === "agent-runtime:surfaces") {
        try {
          const inspectFn =
            inspect ?? (await import("./surfaces.mjs")).inspectSurfaces;
          report.changes = await inspectFn({ root, base });
          const pending = report.changes.some((change) => !change.disposition);
          gate = {
            name,
            status: pending ? "failed" : "passed",
            exitCode: pending ? 1 : 0,
          };
        } catch {
          gate = { name, status: "incomplete", exitCode: null };
        }
      } else {
        try {
          const result = execute(
            "pnpm",
            [name, ...(name === "models:verify" ? ["--strict"] : [])],
            {
              cwd: root,
              env,
              timeout: 8 * 60_000,
              maxBuffer: 8 * 1024 * 1024,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const code =
            Number.isInteger(result.status) &&
            result.status >= 0 &&
            result.status <= 255
              ? result.status
              : null;
          gate = {
            name,
            status:
              result.error || code === null
                ? "incomplete"
                : code === 0
                  ? "passed"
                  : "failed",
            exitCode: result.error ? null : code,
          };
          // No command output is accepted into the public report. CI can still
          // name the failing gate without exposing subprocess account/config data.
        } catch {
          /* Preserve the incomplete outcome and run the remaining gates. */
        }
      }
    }
    gates.push(gate);
    console.log(`${name}: ${gate.status} (${gate.exitCode ?? "no exit code"})`);
    writeFileSync(join(output, "report.json"), `${JSON.stringify(report)}\n`);
  }
  validateReport(report);
  return report;
}
