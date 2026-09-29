import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computerOutputSanitation,
  computerImageCommand,
  releaseImageSanitation,
  releaseImageAttestation,
  releaseImageAttestationStatus,
} from "./computer-image-scripts.js";

describe("real image output sanitation primitive", () => {
  it("shares the exact release-kit sanitation and attestation primitives", () => {
    for (const [name, script] of [["sanitize.sh", releaseImageSanitation], ["attest.sh", releaseImageAttestation], ["attest-status.sh", releaseImageAttestationStatus]]) {
      expect(script).toBe(readFileSync(new URL(`../../../../scripts/cloud-workspace-validation/boat-image/templates/${name}`, import.meta.url), "utf8"));
    }
  });
  it("removes planted credentials/history while retaining an executable and data", () => {
    const root = mkdtempSync(path.join(tmpdir(), "w12-sanitize-"));
    try {
      mkdirSync(path.join(root, ".codex"));
      mkdirSync(path.join(root, "bin"));
      writeFileSync(
        path.join(root, ".codex/auth.json"),
        "synthetic-private-canary",
      );
      writeFileSync(
        path.join(root, ".bash_history"),
        "synthetic-private-canary",
      );
      writeFileSync(
        path.join(root, "bin/org-tool"),
        "#!/bin/sh\nprintf tool-ready",
        { mode: 0o755 },
      );
      const result = execFileSync(
        "python3",
        [
          "-c",
          `${computerOutputSanitation}\nimport sys;print(sanitize_output(sys.argv[1]))`,
          root,
        ],
        { encoding: "utf8" },
      );
      expect(result.trim()).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(path.join(root, ".codex"))).toBe(false);
      expect(existsSync(path.join(root, ".bash_history"))).toBe(false);
      expect(readFileSync(path.join(root, "bin/org-tool"), "utf8")).toContain(
        "tool-ready",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects output aliases outside the sanitized tree", () => {
    const root = mkdtempSync(path.join(tmpdir(), "w12-sanitize-"));
    try {
      symlinkSync("/etc/passwd", path.join(root, "escape"));
      expect(() =>
        execFileSync(
          "python3",
          [
            "-c",
            `${computerOutputSanitation}\nimport sys;sanitize_output(sys.argv[1])`,
            root,
          ],
          { stdio: "pipe" },
        ),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("passes recipe text as encoded data, never executable shell interpolation", () => {
    const command = computerImageCommand("start", {
      recipe: "$(unexpected) `unexpected`",
      timeout: 30,
    });
    expect(command).not.toContain("$(unexpected)");
    expect(command).not.toContain("`unexpected`");
    expect(command).toContain("/usr/bin/env -i");
  });
});
