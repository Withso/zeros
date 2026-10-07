import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  load(
    readFileSync(
      new URL(`../../.github/workflows/${file}`, import.meta.url),
      "utf8",
    ),
  ) as any;

function condition(
  expression: string,
  inputs: Record<string, unknown>,
  event = "pull_request",
) {
  return new Function(
    "github",
    "inputs",
    "needs",
    "always",
    `return (${expression.replaceAll("needs.control-plane-scope", 'needs["control-plane-scope"]')});`,
  )(
    { event_name: event },
    inputs,
    { "control-plane-scope": { outputs: { database: "true" } } },
    () => true,
  );
}

describe("shared PR verification", () => {
  it("runs complementary assurance in the same run without making it a merge dependency", () => {
    const ci = read("ci.yml").jobs;
    expect(ci.assurance?.uses).toBe("./.github/workflows/preflight.yml");
    expect(ci.extended?.uses).toBe("./.github/workflows/scheduled.yml");
    expect(ci["ci-gate"].needs).not.toContain("assurance");
    expect(ci["full-assurance"].needs).toEqual([
      "ci-gate",
      "assurance",
      "extended",
    ]);
    expect(read("ci-full.yml").on).not.toHaveProperty("pull_request");
    expect(ci.assurance.with.full_database).toBe(true);
  });

  it("assigns each expensive workload exactly once across every selection combination", () => {
    const jobs = read("preflight.yml").jobs;
    const workloads = {
      quality: "quality",
      vitest: "test-shard",
      build: "build",
      macos: "source-sync-workload",
      database: "control-plane-database",
      ui_smoke: "ui-smoke-shard",
    };
    for (let mask = 0; mask < 64; mask++) {
      const inputs = Object.fromEntries(
        Object.keys(workloads).map((flag, i) => [
          `pr_selected_${flag}`,
          Boolean(mask & (1 << i)),
        ]),
      );
      for (const [flag, id] of Object.entries(workloads)) {
        const selected = inputs[`pr_selected_${flag}`];
        expect(
          Number(selected) + Number(condition(jobs[id].if, inputs)),
          `${mask}:${id}`,
        ).toBe(1);
        for (const event of ["push", "merge_group"])
          expect(condition(jobs[id].if, inputs, event), `${event}:${id}`).toBe(
            true,
          );
      }
    }
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      expect(
        condition(jobs["control-plane-static"].if, {
          pr_control_plane_static_result: result,
        }),
      ).toBe(false);
      const input = jobs["control-plane"].steps.find(
        (s: any) => s.name === "Enforce control-plane results",
      ).env.STATIC_RESULT;
      expect(
        condition(input.slice(3, -2), {
          pr_control_plane_static_result: result,
        }),
      ).toBe(result);
    }
    expect(
      condition(jobs["control-plane-static"].if, {
        pr_control_plane_static_result: "",
      }),
    ).toBe(true);
  });

  it("never reports full coverage when either producer graph is missing or fails", () => {
    const step = read("ci.yml").jobs["full-assurance"].steps[0];
    for (const key of [
      "SELECTED_RESULT",
      "REMAINING_RESULT",
      "EXTENDED_RESULT",
    ]) {
      for (const result of ["success", "failure", "skipped", "cancelled", ""]) {
        const execution = spawnSync("bash", ["-c", step.run], {
          env: {
            ...process.env,
            SELECTED_RESULT: "success",
            REMAINING_RESULT: "success",
            EXTENDED_RESULT: "success",
            [key]: result,
          },
        });
        expect(execution.status === 0, `${key}:${result}`).toBe(
          result === "success",
        );
      }
    }
  });

  it("runs exactly the same three browser shards as release Preflight", () => {
    const ci = read("ci.yml").jobs;
    const full = read("preflight.yml").jobs;
    expect(ci["ui-smoke-shard"]).toBeDefined();
    expect(ci["ui-smoke-shard"].strategy).toEqual(
      full["ui-smoke-shard"].strategy,
    );
    expect(ci["ui-smoke-shard"].steps.slice(1)).toEqual(
      full["ui-smoke-shard"].steps,
    );
    expect(ci["ui-smoke"].needs).toEqual(["scope", "ui-smoke-shard"]);
    expect(ci["ui-smoke"].name).toBe("ui-smoke (composer)");
  });

  it("rejects failed, cancelled, or missing selected browser shards", () => {
    const step = read("ci.yml").jobs["ui-smoke"].steps.find(
      (s: any) => s.name === "Verify CI selection",
    );
    expect(step).toBeDefined();
    for (const selected of ["true", "false", "", "TRUE"]) {
      for (const result of ["success", "skipped", "failure", "cancelled", ""]) {
        const execution = spawnSync("bash", ["-c", step.run], {
          env: {
            ...process.env,
            SCOPE_RESULT: "success",
            LANE_SELECTED: selected,
            LANE_RESULT: result,
          },
        });
        expect(execution.status === 0, `${selected}:${result}`).toBe(
          (selected === "true" && result === "success") ||
            (selected === "false" && ["success", "skipped"].includes(result)),
        );
      }
    }
  });
});
