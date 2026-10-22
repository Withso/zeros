import { describe, expect, it } from "vitest";

import {
  CLOUD_V2_MAX_HISTORY_ROWS,
  CLOUD_V2_RELAY_PROTOCOL,
  CloudV2WorkerHelloSchema,
  CloudV2WorkerHistorySchema,
  CloudV2WorkerActivityReplySchema,
  CloudV2CapabilitiesSchema,
  CloudV2ControlFrameSchema,
  CloudV2WorkerFrameSchema,
} from "../cloud-v2-relay";

const id = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const capabilities = { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"] };

describe("cloud v2 relay contract", () => {
  it("accepts a worker hello and never lets a worker claim Design, browser or simulators", () => {
    expect(CloudV2WorkerFrameSchema.parse({ t: "hello", protocol: CLOUD_V2_RELAY_PROTOCOL, workerVersion: "0.1.0", capabilities }).t).toBe("hello");
    for (const tab of ["design", "browser", "simulators"]) {
      expect(CloudV2CapabilitiesSchema.safeParse({ ...capabilities, [tab]: true }).success).toBe(false);
    }
  });

  it("fences HTTPS requests by protocol, boot and bounded history sequence", () => {
    const hello = { protocol: CLOUD_V2_RELAY_PROTOCOL, bootId: id, runtimeSha256: "a".repeat(64) };
    expect(CloudV2WorkerHelloSchema.safeParse(hello).success).toBe(true);
    expect(CloudV2WorkerHelloSchema.safeParse({ ...hello, protocol: 1 }).success).toBe(false);
    expect(CloudV2WorkerHelloSchema.safeParse({ ...hello, runtimeSha256: "latest" }).success).toBe(false);
    expect(CloudV2WorkerHistorySchema.safeParse({ t: "history", bootId: id, sequence: 1, chats: [{ id: "chat" }] }).success).toBe(true);
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(CloudV2WorkerHistorySchema.safeParse({ t: "history", bootId: id, sequence }).success).toBe(false);
    expect(CloudV2WorkerActivityReplySchema.safeParse({ loginRevision: "2", state: "running" }).success).toBe(true);
    expect(CloudV2WorkerActivityReplySchema.safeParse({ loginRevision: "-1", state: "running" }).success).toBe(false);
  });

  it("forwards bridge frames opaquely and allows a broadcast target", () => {
    const frame = { type: "AGENT_SESSION_UPDATE", sessionId: "s", notification: {} };
    const up = CloudV2WorkerFrameSchema.parse({ t: "frame", clientId: "*", frame });
    const down = CloudV2ControlFrameSchema.parse({ t: "frame", clientId: id, frame });
    expect(up.t === "frame" && up.frame).toEqual(frame);
    expect(down.t === "frame" && down.frame).toEqual(frame);
    expect(CloudV2ControlFrameSchema.safeParse({ t: "frame", clientId: "*", frame }).success).toBe(false);
  });

  it("carries history rows in the shape Local persists, bounded per frame", () => {
    const row = { msgId: "m1", kind: "agent", payload: "{\"id\":\"m1\"}", createdAt: 1 };
    expect(CloudV2WorkerFrameSchema.parse({ t: "history", messages: { chatId: "c1", rows: [row] } }).t).toBe("history");
    const tooMany = Array.from({ length: CLOUD_V2_MAX_HISTORY_ROWS + 1 }, (_, i) => ({ ...row, msgId: `m${i}` }));
    expect(CloudV2WorkerFrameSchema.safeParse({ t: "history", messages: { chatId: "c1", rows: tooMany } }).success).toBe(false);
    expect(CloudV2WorkerFrameSchema.safeParse({ t: "history", messages: { chatId: "c1", rows: [{ ...row, extra: 1 }] } }).success).toBe(false);
  });

  it("keeps token replies and refusals distinct and rejects unknown frames", () => {
    expect(CloudV2ControlFrameSchema.parse({ t: "reply", id, token: "ghs_x", expiresAt: 1 }).t).toBe("reply");
    expect(CloudV2ControlFrameSchema.parse({ t: "refusal", id, code: "workspace_stopped" }).t).toBe("refusal");
    expect(CloudV2ControlFrameSchema.safeParse({ t: "reply", id, code: "x" }).success).toBe(false);
    expect(CloudV2WorkerFrameSchema.safeParse({ t: "exec", command: "rm -rf /" }).success).toBe(false);
    expect(CloudV2WorkerFrameSchema.safeParse({ t: "request", id, kind: "proxy-token" }).success).toBe(false);
  });

  it("delivers a Codex proxy login, direct Claude login and Cursor key, nothing else", () => {
    const proxy = { baseUrl: "https://api.zeros.build/v2/cloud/proxy/openai", token: "z".repeat(32), expiresAt: 2 };
    const config = {
      t: "config", loginRevision: "0",
      workspace: { id, organizationId: id, checkoutPath: "/home/user/withso/zeros", repository: "withso/zeros", branch: "zeros/cloud-1", baseBranch: "main" },
      agents: { codex: proxy, claude: { oauthToken: "offline-oauth-placeholder" }, cursor: { apiKey: "key" } },
    };
    expect(CloudV2ControlFrameSchema.parse(config).t).toBe("config");
    expect(CloudV2ControlFrameSchema.safeParse({ ...config, agents: { codex: { ...proxy, refreshToken: "r" } } }).success).toBe(false);
    expect(CloudV2ControlFrameSchema.safeParse({ ...config, agents: { claude: proxy } }).success).toBe(false);
    expect(CloudV2ControlFrameSchema.safeParse({ ...config, agents: {} }).success).toBe(true);
  });

  it.each(["oauthToken", "apiKey"])("accepts only one bounded Claude %s credential", (field) => {
    const config = {
      t: "config", loginRevision: "0",
      workspace: { id, organizationId: id, checkoutPath: "/home/user/fixture/repo", repository: "fixture/repo", branch: "workspace/fixture", baseBranch: "main" },
    };
    for (const length of [16, 16384])
      expect(CloudV2ControlFrameSchema.safeParse({ ...config, agents: { claude: { [field]: "x".repeat(length) } } }).success).toBe(true);
    for (const length of [0, 15, 16385])
      expect(CloudV2ControlFrameSchema.safeParse({ ...config, agents: { claude: { [field]: "x".repeat(length) } } }).success).toBe(false);
    for (const extra of [{ oauthToken: "offline-oauth-placeholder", apiKey: "offline-api-key-placeholder" }, { [field]: "offline-placeholder", baseUrl: "https://example.com" }, {}])
      expect(CloudV2ControlFrameSchema.safeParse({ ...config, agents: { claude: extra } }).success).toBe(false);
  });
});
