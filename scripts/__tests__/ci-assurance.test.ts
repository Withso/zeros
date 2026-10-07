import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type Job = {
  name?: string;
  if?: string;
  needs?: unknown;
  uses?: string;
  secrets?: unknown;
  permissions?: Record<string, string>;
  environment?: unknown;
  with?: Record<string, unknown>;
  outputs?: Record<string, string>;
  steps?: {
    name?: string;
    uses?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
  }[];
};
type Workflow = {
  name: string;
  on: Record<string, any>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": string | boolean };
  jobs: Record<string, Job>;
};

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (name: string) =>
  load(
    readFileSync(path.join(ROOT, ".github/workflows", name), "utf8"),
  ) as Workflow;

function expression(value: string, github: Record<string, any>, inputs = {}) {
  const body = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(value)?.[1];
  if (!body) throw new Error(`Not a GitHub expression: ${value}`);
  const format = (template: string, ...values: unknown[]) =>
    template.replace(/\{(\d+)\}/g, (_, index: string) =>
      String(values[Number(index)]),
    );
  return new Function(
    "github",
    "inputs",
    "steps",
    "format",
    `return (${body});`,
  )(github, inputs, { scope: { outputs: { database: "false" } } }, format);
}

describe("independent full CI assurance", () => {
  it("runs full PR coverage through one selected/complementary graph", () => {
    const ci = read("ci.yml");
    expect(ci.on).toHaveProperty("pull_request");
    expect(ci.on).not.toHaveProperty("pull_request_target");
    expect(ci.on.pull_request?.paths).toBeUndefined();
    expect(ci.jobs.assurance).toMatchObject({
      name: "Remaining full suite",
      uses: "./.github/workflows/preflight.yml",
      with: { full_database: true },
    });
    expect(ci.jobs["ci-gate"].needs).not.toContain("assurance");
    expect(ci.jobs["ci-gate"].needs).not.toContain("extended");
    expect(read("ci-full.yml").on).not.toHaveProperty("pull_request");
  });

  it("forces all database shards even for a documentation-only assurance run", () => {
    const scope = read("preflight.yml").jobs["control-plane-scope"];
    const decision = scope.steps!.find(
      (step) => step.name === "Decide whether the database suites run",
    )!;
    expect(
      expression(decision.env!.CI_FULL_DATABASE, {}, { full_database: true }),
    ).toBe(true);
    expect(
      expression(decision.env!.CI_FULL_DATABASE, {}, { full_database: false }),
    ).toBe(false);
    expect(scope.outputs!.database).toBe("${{ steps.scope.outputs.database }}");
  });

  it("keeps native ABI and unsigned packaging coverage independent on PRs and every main/release push", () => {
    const assurance = read("ci-full.yml");
    expect(assurance.on.push).toEqual({ branches: ["main", "release/**"] });
    expect(assurance.jobs.extended).toEqual({
      name: "Extended checks",
      uses: "./.github/workflows/scheduled.yml",
    });
    const extended = read("scheduled.yml");
    expect(extended.on).toHaveProperty("workflow_call");
    expect(extended.on).toHaveProperty("schedule");
    expect(extended.on).toHaveProperty("workflow_dispatch");
    expect(Object.keys(extended.jobs).sort()).toEqual([
      "electron-pack",
      "native-abi",
      "runtime-drift",
    ]);
  });

  it("never grants fork PR assurance deployment authority or inherited secrets", () => {
    for (const name of [
      "ci.yml",
      "ci-full.yml",
      "preflight.yml",
      "scheduled.yml",
    ]) {
      const workflow = read(name);
      expect(workflow.permissions).toEqual({ contents: "read" });
      expect(workflow.on.workflow_call?.secrets).toBeUndefined();
      for (const job of Object.values(workflow.jobs)) {
        expect(job.secrets).toBeUndefined();
        expect(job.environment).toBeUndefined();
        expect(
          Object.values(job.permissions ?? {}).every(
            (permission) => permission !== "write",
          ),
        ).toBe(true);
      }
    }
  });

  it("keeps the canonical PR secret scanner and omits release-only gates from assurance", () => {
    const preflight = read("preflight.yml");
    const direct = { event_name: "push" };
    const assurance = { event_name: "pull_request" };
    for (const id of ["secret-scan", "alpha-gate"]) {
      const condition = preflight.jobs[id].if!;
      const admitted = new Function(
        "github",
        "always",
        `return (${condition});`,
      );
      expect(
        admitted(assurance, () => true),
        id,
      ).toBe(false);
      expect(
        admitted(direct, () => true),
        id,
      ).toBe(true);
    }
    const scanner = read("ci.yml").jobs["secret-scan"];
    // ci-selection-workflow.test.ts exercises the trusted scope and its
    // failure path; assurance does not replace that canonical producer.
    expect(scanner.needs).toBe("scope");
    expect(scanner.name).toBe("secret scan (PR commit range)");
  });

  it("namespaces reused checks so assurance cannot satisfy a fast required context", () => {
    const required = new Set(
      Object.entries(read("ci.yml").jobs).map(([id, job]) => job.name ?? id),
    );
    const assurance = read("ci-full.yml");
    expect(assurance.name).not.toBe("Preflight");
    for (const [id, call] of Object.entries(assurance.jobs)) {
      const callee = read(path.basename(call.uses!));
      for (const [childId, child] of Object.entries(callee.jobs)) {
        expect(
          required.has(`${call.name ?? id} / ${child.name ?? childId}`),
        ).toBe(false);
      }
    }
  });

  it("never coalesces extended push assurance", () => {
    const concurrency = read("ci-full.yml").concurrency!;
    const group = (github: Record<string, any>) =>
      expression(concurrency.group, github);
    for (const ref of ["refs/heads/main", "refs/heads/release/1.0.0"]) {
      const push = { event_name: "push", event: {}, ref, run_id: 20 };
      expect(group(push)).not.toBe(group({ ...push, run_id: 21 }));
      expect(expression(String(concurrency["cancel-in-progress"]), push)).toBe(
        false,
      );
    }
  });

  it("adds CodeQL quality queries without dropping the extended security suite", () => {
    const codeql = read("codeql.yml");
    const init = codeql.jobs.analyze.steps!.find((step) =>
      step.uses?.startsWith("github/codeql-action/init@"),
    );
    // GitHub's security-and-quality suite includes all security-extended queries.
    expect(init?.with).toMatchObject({
      languages: "javascript-typescript",
      queries: "security-and-quality",
    });
    expect(codeql.on).toHaveProperty("pull_request");
    expect(codeql.on.push.branches).toEqual(["main", "release/**"]);
  });
});
