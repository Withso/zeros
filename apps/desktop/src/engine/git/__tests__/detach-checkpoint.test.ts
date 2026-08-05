// Detach checkpoint unwind logic (pure). detachStop soft-resets the
// trailing "zeros: detach checkpoint" commits off the workspace branch so
// detach doesn't litter history — but must stop at the first real commit.

import { describe, expect, it } from "vitest";

import { trailingCheckpointCount } from "../detach";

const CP = "zeros: detach checkpoint";

describe("trailingCheckpointCount", () => {
  it("counts consecutive trailing checkpoints (newest first)", () => {
    expect(trailingCheckpointCount([CP, CP, CP, "feat: real"])).toBe(3);
  });

  it("stops at the first real commit (preserves a mid-detach user commit)", () => {
    expect(trailingCheckpointCount([CP, "feat: real", CP, CP])).toBe(1);
  });

  it("is 0 when HEAD is not a checkpoint", () => {
    expect(trailingCheckpointCount(["fix: real", CP])).toBe(0);
  });

  it("handles all-checkpoints and the empty list", () => {
    expect(trailingCheckpointCount([CP, CP])).toBe(2);
    expect(trailingCheckpointCount([])).toBe(0);
  });

  it("tolerates trailing whitespace on the subject", () => {
    expect(trailingCheckpointCount([`${CP}  `, CP])).toBe(2);
  });
});
