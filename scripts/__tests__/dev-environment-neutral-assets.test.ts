import { describe, expect, it } from "vitest";
import { workerSourcePath } from "../dev-environment/source.mjs";

describe("neutral runtime source inputs", () => {
  it("includes product search staging in the worker build identity", () => {
    expect(workerSourcePath("scripts/stage-ripgrep.mjs")).toBe(true);
  });
  it.each(["scripts/build-zsr-supervisor.mjs", "scripts/zsr-qualification/pin.json", "scripts/zsr-qualification/run.mjs"])(
    "drops retired sandbox build input %s", file => { expect(workerSourcePath(file)).toBe(false); },
  );
  it("still includes the live provider and runtime deployment closure", () => {
    for (const file of ["scripts/cloud-workspace-validation/runtime-bundle/build.ts", "apps/desktop/src/engine/agents/adapters/cursor-sdk/adapter.ts", "pnpm-lock.yaml"]) {
      expect(workerSourcePath(file)).toBe(true);
    }
  });
});
