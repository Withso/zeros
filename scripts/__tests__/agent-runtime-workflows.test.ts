import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { GATES } from "../agent-runtime/qualification.mjs";

const workflow = (name: string): any =>
  load(
    readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );
const scanner = workflow("agent-runtime-radar");

describe("runtime automation workflow boundaries", () => {
  it("installs and executes candidates only in a separate read-only job", () => {
    expect(scanner.jobs.prepare.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(scanner.jobs.prepare)).not.toContain("secrets.");
    expect(
      scanner.jobs.prepare.steps
        .filter((step: any) => step.uses?.startsWith("actions/checkout@"))
        .every((step: any) => step.with["persist-credentials"] === false),
    ).toBe(true);
    expect(
      scanner.jobs.write.steps.some(
        (step: any) =>
          step.uses?.startsWith("actions/checkout@") ||
          /pnpm install|npm install/.test(step.run ?? ""),
      ),
    ).toBe(false);
    const writerSteps = scanner.jobs.write.steps;
    const verified = writerSteps.findIndex(
      (step: any) =>
        step.name === "Verify trusted tooling before minting a write token",
    );
    const minted = writerSteps.findIndex((step: any) =>
      step.uses?.startsWith("actions/create-github-app-token@"),
    );
    expect(verified).toBeGreaterThan(-1);
    expect(minted).toBeGreaterThan(verified);
    expect(writerSteps[minted].with).toMatchObject({
      owner: "Withso",
      repositories: "zeros",
      "permission-contents": "write",
      "permission-pull-requests": "write",
    });
  });

  it("uses trusted main without a package install for privileged report publication", () => {
    const publisher = workflow("agent-runtime-report");
    expect(publisher.on.workflow_run).toEqual({
      workflows: ["CI"],
      types: ["completed"],
    });
    expect(publisher.permissions).toEqual({
      contents: "read",
      actions: "read",
      issues: "write",
      "pull-requests": "read",
    });
    expect(
      publisher.jobs.publish.steps.find((step: any) =>
        step.uses?.startsWith("actions/checkout@"),
      ).with,
    ).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(JSON.stringify(publisher.jobs.publish.steps)).not.toMatch(
      /pnpm install|npm install|secrets\./,
    );
  });

  it("serializes all state publishers with the controller without cancelling in-flight work", () => {
    for (const name of ["radar", "models", "health", "report"]) {
      const definition = workflow(`agent-runtime-${name}`);
      expect(definition.concurrency).toEqual({
        group: "agent-runtime-state",
        "cancel-in-progress": false,
      });
      for (const job of Object.values<any>(definition.jobs))
        expect(job.concurrency).toBeUndefined();
    }
  });

  it("retains every independent gate in the selected/complementary test inventories", () => {
    const scope = JSON.parse(
      readFileSync(new URL("../ci/scope-rules.json", import.meta.url), "utf8"),
    );
    const entries = scope.jobs.vitest.map((id: string) => scope.checks[id]);
    for (const gate of GATES)
      expect(
        entries.some(
          (entry: any) =>
            entry.execution_group.includes("runtime-qualification") &&
            entry.commands.some(
              (command: string) =>
                command === `pnpm ${gate}` ||
                command.startsWith(`pnpm ${gate} `),
            ),
        ),
        gate,
      ).toBe(true);
    const ci = workflow("ci"),
      preflight = workflow("preflight");
    expect(ci.jobs["runtime-qualification"].needs).toBe("scope");
    expect(ci.jobs["runtime-qualification"].if).toContain(
      "needs.scope.outputs.job-vitest == 'true'",
    );
    expect(preflight.jobs["runtime-qualification"].if).toContain(
      "!inputs.pr_selected_vitest",
    );
    for (const caller of [ci, preflight]) {
      expect(caller.jobs.test.needs).toContain("runtime-qualification");
      expect(caller.jobs["runtime-qualification"].uses).toBe(
        "./.github/workflows/agent-runtime-qualification.yml",
      );
      expect(
        caller.jobs.test.steps.some(
          (step: any) =>
            step.name === "Enforce the runtime result" &&
            step.run.includes('"$RUNTIME_RESULT" != "success"'),
        ),
      ).toBe(true);
    }
    const steps = workflow("agent-runtime-qualification").jobs.qualification
      .steps;
    expect(
      steps.find(
        (step: any) => step.name === "Run every independent runtime gate",
      ).if,
    ).toBe("always()");
    expect(
      steps.find(
        (step: any) => step.name === "Save runtime qualification report",
      ).if,
    ).toBe("always()");
  });

  it("does not provide provider credentials to writers or PR qualification", () => {
    expect(
      JSON.stringify(workflow("agent-runtime-qualification")),
    ).not.toContain("secrets.");
    expect(JSON.stringify(scanner)).not.toMatch(
      /AGENT_RUNTIME_(?:ANTHROPIC|CLAUDE|OPENAI|CODEX|CURSOR)/,
    );
    const models = workflow("agent-runtime-models");
    expect(JSON.stringify(models.jobs.publish)).not.toContain("secrets.");
    expect(models.jobs.discover.if).toContain(
      "github.ref == 'refs/heads/main'",
    );
    expect(models.jobs.discover.if).toContain(
      "vars.ZEROS_AGENT_RUNTIME_MODELS == 'enabled'",
    );
    expect(models.jobs.discover.permissions).toBeUndefined();
    expect(models.permissions).toEqual({ contents: "read" });
  });
});
