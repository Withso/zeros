import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promotionConfig } from "./contracts";
import { releaseChannelEnvironment } from "./channel-policy.mjs";

// Every channel allows cloud in the checked-in policy. A case pauses one
// channel here; the shared policy reads this object on every call.
const policy = vi.hoisted(() => ({ development: true, alpha: true, beta: true, production: true } as Record<string, boolean>));
vi.mock("../../apps/control-plane/src/cloud/channels.json", () => ({ default: policy }));

const sourceSha = "a".repeat(40);
function environment(channel: "beta" | "production") {
  return {
    RELEASE_CHANNEL: channel, RELEASE_SHA: sourceSha, RELEASE_BRANCH: "release/1.2.3", GITHUB_SHA: sourceSha,
    GITHUB_REPOSITORY: "example/zeros", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    ZEROS_HOSTED_PROMOTION: "enabled", ZEROS_CLOUD_WORKSPACES_ENABLED: "true",
    RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111", RAILWAY_ENVIRONMENT_ID: "22222222-2222-4222-8222-222222222222",
    RAILWAY_SERVICE_ID: "33333333-3333-4333-8333-333333333333", PLANETSCALE_ORG: "example",
    PLANETSCALE_DATABASE: `zeros-control-plane-${channel}`, PLANETSCALE_BRANCH: "main",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), CF_PAGES_APP_PROJECT: channel === "beta" ? "zeros-web-beta" : "zeros-web",
    CF_PAGES_OPS_PROJECT: channel === "beta" ? "" : "zeros-ops", AUTH_PROVIDER: "workos",
    RAILWAY_DEPLOY_TOKEN: "synthetic", PLANETSCALE_SERVICE_TOKEN_ID: "synthetic", PLANETSCALE_SERVICE_TOKEN: "synthetic",
    CLOUDFLARE_API_TOKEN: "synthetic",
  };
}

describe("release channel environment", () => {
  it("preserves the existing exact-true validation on an unpaused channel", () => {
    expect(releaseChannelEnvironment("alpha", {})).toEqual({
      ZEROS_CLOUD_WORKSPACES_ENABLED: "false",
    });
    expect(releaseChannelEnvironment("alpha", { ZEROS_CLOUD_WORKSPACES_ENABLED: "true" }))
      .toEqual({ ZEROS_CLOUD_WORKSPACES_ENABLED: "true" });
    expect(() => releaseChannelEnvironment("alpha", { ZEROS_CLOUD_WORKSPACES_ENABLED: "TRUE" }))
      .toThrow("Invalid desktop cloud capability");
  });

  it("makes stale cloud-only settings inert while the channel is paused", () => {
    expect(releaseChannelEnvironment("beta", { ZEROS_CLOUD_WORKSPACES_ENABLED: "obsolete" }, { ...policy, beta: false }))
      .toEqual({ ZEROS_CLOUD_WORKSPACES_ENABLED: "false" });
    expect(() => releaseChannelEnvironment("unknown", {})).toThrow("Unknown cloud release channel");
  });

  it.each(["beta", "production"])("applies the %s release environment's exact decision", channel => {
    expect(releaseChannelEnvironment(channel, {})).toEqual({ ZEROS_CLOUD_WORKSPACES_ENABLED: "false" });
    expect(releaseChannelEnvironment(channel, { ZEROS_CLOUD_WORKSPACES_ENABLED: "true" }))
      .toEqual({ ZEROS_CLOUD_WORKSPACES_ENABLED: "true" });
    expect(() => releaseChannelEnvironment(channel, { ZEROS_CLOUD_WORKSPACES_ENABLED: "obsolete" }))
      .toThrow("Invalid desktop cloud capability");
  });
});

describe.each(["beta", "production"] as const)("%s cloud release", channel => {
  it("requires cloud exactly when the release environment opts in", () => {
    expect(promotionConfig(environment(channel))).toMatchObject({ cloudRequired: true });
    expect(promotionConfig({ ...environment(channel), ZEROS_CLOUD_WORKSPACES_ENABLED: "false" }))
      .toMatchObject({ cloudRequired: false });
  });
});

describe.each(["beta", "production"] as const)("%s release while its channel is paused", channel => {
  beforeEach(() => { policy[channel] = false; });
  afterEach(() => { policy[channel] = true; });

  it("disables cloud despite stale protected cloud settings", () => {
    expect(promotionConfig(environment(channel))).toMatchObject({ cloudRequired: false });
  });

  it("keeps migration target and provider authority validation mandatory", () => {
    for (const patch of [{ PLANETSCALE_DATABASE: "foreign-database" }, { PLANETSCALE_SERVICE_TOKEN: "" },
      { RELEASE_SHA: "c".repeat(40) }, { AUTH_PROVIDER: "unknown" }, { AUTH_PROVIDER: "auth0" }]) {
      expect(() => promotionConfig({ ...environment(channel), ...patch })).toThrow();
    }
  });

  it("accepts the WorkOS facade with or without an explicit AUTH_PROVIDER", () => {
    for (const value of [undefined, "", "workos", " WorkOS "]) {
      expect(() => promotionConfig({ ...environment(channel), AUTH_PROVIDER: value })).not.toThrow();
    }
  });

  it("bakes and publishes cloud=false while retaining CI, hosted promotion and platform checks", () => {
    const workflow = load(readFileSync(`.github/workflows/${channel === "beta" ? "release-beta" : "release"}.yml`, "utf8")) as {
      jobs: Record<string, { env?: Record<string, string>; needs?: string[]; steps?: { run?: string }[] }>;
    };
    expect(releaseChannelEnvironment(channel, environment(channel), policy)).toEqual({
      ZEROS_CLOUD_WORKSPACES_ENABLED: "false",
    });
    for (const job of [workflow.jobs.build, workflow.jobs.publish]) {
      expect(job.steps?.some(step => step.run === "node scripts/release/channel-policy.mjs --github-env")).toBe(true);
    }
    expect(workflow.jobs.publish.needs).toEqual(expect.arrayContaining(["ci", "build", "hosted"]));
    if (channel === "production") expect(workflow.jobs.publish.needs).toEqual(expect.arrayContaining(["approve", "notarize"]));
    expect(workflow.jobs.ci.steps?.some(step => step.run?.includes("scripts/release/ci-cli.ts --wait"))).toBe(true);
    expect(workflow.jobs.build.steps?.some(step => step.run === "pnpm smoke:engine")).toBe(true);
    expect(workflow.jobs.build.steps?.some(step => step.run === "pnpm smoke:packaged-pty")).toBe(true);
  });
});
