import { expect, it } from "vitest";
import { CloudV2ControlFrameSchema, CREATOR_AGENT_LOGINS_FEATURE } from "@zeros/protocol/cloud-v2-relay";
import { providerAvailability } from "../provider-failure";
import { CLOUD_WORKER_FEATURES } from "../worker-features";
import { config } from "./worker-fixtures";

/** Creator pays: an activated config names which agents the CURRENT Creator has a selected login for (no secret). */
const acting = { ...config, agents: {}, actingUser: 1 as const, gitIdentity: null };

it("advertises creator-agent-logins-v1, so the control plane sends agentLogins only to a worker that parses it", () => {
  expect(CREATOR_AGENT_LOGINS_FEATURE).toBe("creator-agent-logins-v1");
  expect(CLOUD_WORKER_FEATURES.split(",")).toContain(CREATOR_AGENT_LOGINS_FEATURE);
});

it("parses agentLogins as a strict sparse true-only map; known empty is {}", () => {
  expect(CloudV2ControlFrameSchema.safeParse({ ...acting, agentLogins: { claude: true } }).success).toBe(true);
  expect(CloudV2ControlFrameSchema.safeParse({ ...acting, agentLogins: {} }).success).toBe(true);
  for (const bad of [{ claude: false }, { gemini: true }, { claude: "yes" }]) expect(CloudV2ControlFrameSchema.safeParse({ ...acting, agentLogins: bad }).success).toBe(false);
});

it("shows an activated workspace's agents as the Creator's logins allow, and keeps today's answer when the map is absent", () => {
  const known = { ...acting, agentLogins: { claude: true as const } } as never;
  expect(providerAvailability("claude", known, true)).toBeUndefined();
  expect(providerAvailability("codex", known, true)).toEqual({ source: "provider", provider: "codex", reason: "auth-required" });
  expect(providerAvailability("cursor", { ...acting, agentLogins: {} } as never, true)).toEqual({ source: "provider", provider: "cursor", reason: "auth-required" });
  expect(providerAvailability("claude", known, false)).toEqual({ source: "provider", provider: "claude", reason: "provider-unavailable" });
  // An older control plane: no map, the existing (unknown) answer.
  expect(providerAvailability("claude", acting as never, true)).toEqual({ source: "provider", provider: "claude", reason: "auth-required" });
});
