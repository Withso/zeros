import { describe, expect, it } from "vitest";
import { workerSourcePath } from "../dev-environment/source.mjs";

describe("standalone worker source inputs", () => {
  it.each([
    "apps/cloud-worker/src/main.ts", "apps/cloud-worker/scripts/build.mjs",
    "packages/protocol/src/cloud-v2-relay.ts", "pnpm-lock.yaml", "package.json",
  ])("includes runtime input %s", file => {
    expect(workerSourcePath(file)).toBe(true);
  });
  it.each([
    "apps/desktop/src/engine/agents/adapters/cursor-sdk/adapter.ts",
    "scripts/stage-ripgrep.mjs", "scripts/build-zsr-supervisor.mjs",
    "scripts/cloud-workspace-validation/runtime-bundle/build.ts",
  ])("does not rebuild the standalone worker for %s", file => {
    expect(workerSourcePath(file)).toBe(false);
  });
});
