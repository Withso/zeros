import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { basePayload } from "../cloud-workspace-validation/boat-image/runtime-base-v4";
import { BaseCompatibilitySchema } from "../../packages/protocol/src/cloud-runtime-bundle";
import { parseComputerSelfTestReport } from "../cloud-workspace-validation/sandbox/cloud-computer-self-test.mjs";

it("ships the base-owned Computer integrity reader in the pinned base payload", () => {
  const payload = basePayload(process.cwd(), "a".repeat(40), "b".repeat(32));
  expect(payload.files.some(file => file.name === "base/computer-boot-integrity.py")).toBe(true);
  expect(payload.files.some(file => file.name === "base/computer-build-qualification.py")).toBe(true);
});

it("negotiates an explicit optional base version and shares the complete self-test fixture with Python", () => {
  const base = JSON.parse(readFileSync("scripts/cloud-workspace-validation/runtime-base-v4/compatibility.json", "utf8"));
  base.protectedFiles = [{ path: "/opt/zeros-bootstrap/bootstrap.py", mode: "0555", sha256: "a".repeat(64) }];
  expect(BaseCompatibilitySchema.safeParse({ ...base, buildQualificationVersion: 1 }).success).toBe(true);
  expect(BaseCompatibilitySchema.safeParse({ ...base, buildQualificationVersion: 2 }).success).toBe(false);
  delete base.buildQualificationVersion;
  expect(BaseCompatibilitySchema.safeParse(base).success).toBe(true);
  const report = JSON.parse(readFileSync("scripts/__tests__/fixtures/cloud-computer-self-test.valid.json", "utf8"));
  expect(parseComputerSelfTestReport(report)).toEqual(report);
});

it.skipIf(process.platform !== "linux")("checks original running-kernel identity and bounded descriptor reads", () => {
  const result = spawnSync("python3", [path.resolve("scripts/cloud-workspace-validation/runtime-base-v4/tests/test_computer_boot_integrity.py")],
    { encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  expect(result.status, result.stderr).toBe(0);
});

it.skipIf(process.platform !== "linux")("checks immutable build evidence and fresh selected-proof refusal", () => {
  const result = spawnSync("python3", ["-I", "-B", path.resolve("scripts/cloud-workspace-validation/runtime-base-v4/tests/test_computer_build_qualification.py")],
    { encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  expect(result.status, result.stderr).toBe(0);
});

it.skipIf(process.platform !== "linux")("joins the fixed verifier channel through real cancellation and original lock checks", () => {
  const result = spawnSync("python3", ["-I", "-B", path.resolve("scripts/cloud-workspace-validation/runtime-base-v4/tests/test_build_verifier_transport.py")],
    { encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  expect(result.status, result.stderr).toBe(0);
});
