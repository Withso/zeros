import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATES,
  qualify,
  validateQualification,
  validateReport,
} from "../agent-runtime/qualification.mjs";

describe("independent runtime qualification", () => {
  it("runs every gate after an earlier failure and writes real outcomes", async () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-gates-")),
      calls: any[] = [];
    try {
      const report = await qualify({
        root,
        output: root,
        head: "a".repeat(40),
        testedHead: "b".repeat(40),
        base: "c".repeat(40),
        execute: (command: string, args: string[], options: any) => {
          calls.push({ command, args, options });
          return { status: args[0] === "check:runtime-pins" ? 1 : 0 };
        },
        inspect: async () => [],
        environment: {
          PATH: process.env.PATH,
          GH_TOKEN: "fixture-only",
          OPENAI_API_KEY: "fixture-only",
        },
      });
      expect(calls).toHaveLength(GATES.length - 1);
      expect(report.gates[0]).toMatchObject({ status: "failed", exitCode: 1 });
      expect(report.gates.at(-1).status).toBe("passed");
      expect(
        calls.every(
          (call) =>
            !call.options.env.GH_TOKEN && !call.options.env.OPENAI_API_KEY,
        ),
      ).toBe(true);
      expect(
        JSON.parse(readFileSync(join(root, "report.json"), "utf8")),
      ).toEqual(report);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("emits every gate as incomplete when dependency setup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-setup-"));
    try {
      const report = await qualify({
        root,
        output: root,
        head: "a".repeat(40),
        testedHead: "a".repeat(40),
        base: "b".repeat(40),
        setup: false,
        execute: () => {
          throw new Error("must not execute");
        },
      });
      expect(report.gates).toHaveLength(GATES.length);
      expect(
        report.gates.every(
          (gate: any) => gate.status === "incomplete" && gate.exitCode === null,
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("refuses forged gate results, missing checks and stale provenance", () => {
    const report = {
      schema: 1,
      repository: "Withso/zeros",
      head: "a".repeat(40),
      testedHead: "b".repeat(40),
      base: "c".repeat(40),
      pr: 42,
      event: "pull_request",
      runId: 1,
      attempt: 2,
      changes: [],
      gates: GATES.map((name: string) => ({
        name,
        status: "passed",
        exitCode: 0,
      })),
    };
    const expected = {
      run: { id: 1, run_attempt: 2, event: "pull_request" },
      head: report.head,
      testedHead: report.testedHead,
      base: report.base,
      pr: 42,
    };
    expect(validateQualification(report, expected)).toBe(report);
    expect(() =>
      validateQualification(
        { ...report, gates: report.gates.slice(1) },
        expected,
      ),
    ).toThrow("required gate");
    expect(() =>
      validateQualification({ ...report, attempt: 1 }, expected),
    ).toThrow("provenance");
    expect(() =>
      validateReport({
        ...report,
        gates: [{ name: "check:runtime-pins", status: "passed", exitCode: 1 }],
      }),
    ).toThrow("exit code");
  });
});
