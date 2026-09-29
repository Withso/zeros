import { describe, expect, it } from "vitest";
import {
  assertComputerImageAttestation,
  availableComputerImageSlots,
  computerImageFailure,
} from "./computer-image.js";

const hash = "a".repeat(64);
describe("Cloud Computer image trust boundary", () => {
  it("never treats workspace readiness as image attestation", () => {
    expect(() =>
      assertComputerImageAttestation({ status: "ready" }, hash, "b".repeat(40)),
    ).toThrow();
  });
  it("binds fresh-clone attestation to the measured build and source contract", () => {
    const report = {
      qualified: true,
      profile: "zeros-cloud-worker-v3",
      setupQualification: { secure: true },
      metadata: {
        buildSha256: hash,
        build: {
          source: { commit: "b".repeat(40), contractSha256: "c".repeat(64) },
          imageContractSha256: "d".repeat(64),
        },
      },
    };
    expect(
      assertComputerImageAttestation(report, hash, "b".repeat(40)),
    ).toMatchObject({ sourceContract: "c".repeat(64) });
    expect(() =>
      assertComputerImageAttestation(report, "e".repeat(64), "b".repeat(40)),
    ).toThrow();
    expect(() =>
      assertComputerImageAttestation(
        { ...report, setupQualification: { secure: false } },
        hash,
        "b".repeat(40),
      ),
    ).toThrow();
  });
  it("reserves against the global ten-snapshot cap without counting captures twice", () => {
    const inventory = Array.from({ length: 9 }, (_, i) => `release-${i}`);
    expect(availableComputerImageSlots(inventory, [])).toBe(1);
    expect(availableComputerImageSlots(inventory, ["pending"])).toBe(0);
    expect(
      availableComputerImageSlots([...inventory, "pending"], ["pending"]),
    ).toBe(0);
  });
  it("never reflects recipe or provider output in failure messages", () => {
    expect(computerImageFailure(new Error("synthetic-private-canary"))).toBe(
      "image_build_failed",
    );
  });
});
