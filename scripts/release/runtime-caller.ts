import { requireCheck, type Channel } from "./contracts";

export const RUNTIME_WORKFLOWS = ["runtime-release.yml", "release-alpha.yml", "release-beta.yml", "release.yml"] as const;
export type RuntimeWorkflow = typeof RUNTIME_WORKFLOWS[number];
type Action = "publish" | "promote" | "rollback";

export function runtimeCaller(file: RuntimeWorkflow, channel: Channel, action: Action) {
  const automatic = { alpha: "release-alpha.yml", beta: "release-beta.yml", production: "release.yml" } as const;
  requireCheck(file === "runtime-release.yml" || file === automatic[channel] && action === (channel === "alpha" ? "publish" : "promote"),
    "Runtime caller does not own this channel and action");
  return { path: `.github/workflows/${file}`, event: file === "release-alpha.yml" || file === "release-beta.yml" ? "push" : "workflow_dispatch" };
}

export function alphaRuntimeWorkflow(path: string, event: string): RuntimeWorkflow | undefined {
  return (["runtime-release.yml", "release-alpha.yml"] as const).find(file => {
    const caller = runtimeCaller(file, "alpha", "publish");
    return caller.path === path && caller.event === event;
  });
}

export function runtimeJobNames(file: RuntimeWorkflow, kind: "build" | "release" | "approval"): readonly string[] {
  const name = { build: "Runtime archive build", release: "Runtime release transaction", approval: "Approve runtime promotion" }[kind];
  const prefix = file === "release-alpha.yml" ? "Alpha publication / Cloud runtime / " : "Cloud runtime / ";
  // Retained dispatch artifacts predate the reusable runner.
  return file === "runtime-release.yml" ? [name, prefix + name] : [prefix + name];
}
