import { describe, expect, it } from "vitest";

import {
  CLOUD_V2_MAX_HISTORY_ROWS,
  CloudV2CapabilitiesSchema,
  CloudV2ControlFrameSchema,
  CloudV2WorkerFrameSchema,
} from "../cloud-v2-relay";

const id = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const capabilities = { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"] };

describe("cloud v2 relay contract", () => {
  it("accepts a worker hello and never lets a worker claim Design, browser or simulators", () => {
    expect(CloudV2WorkerFrameSchema.parse({ t: "hello", protocol: 1, workerVersion: "0.1.0", capabilities }).t).toBe("hello");
    for (const tab of ["design", "browser", "simulators"]) {
      expect(CloudV2CapabilitiesSchema.safeParse({ ...capabilities, [tab]: true }).success).toBe(false);
    }
  });

  it("forwards bridge frames opaquely and allows a broadcast target", () => {
    const frame = { type: "AGENT_SESSION_UPDATE", sessionId: "s", notification: {} };
    expect(CloudV2WorkerFrameSchema.parse({ t: "frame", clientId: "*", frame }).frame).toEqual(frame);
    expect(CloudV2ControlFrameSchema.parse({ t: "frame", clientId: id, frame }).frame).toEqual(frame);
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

  it("delivers proxy logins with an expiry and a Cursor key, nothing else", () => {
    const proxy = { baseUrl: "https://api.zeros.build/v2/cloud/proxy/openai", token: "z".repeat(32), expiresAt: 2 };
    const config = {
      t: "config",
      workspace: { id, organizationId: id, checkoutPath: "/home/zeros/withso/zeros", repository: "withso/zeros", branch: "zeros/cloud-1", baseBranch: "main" },
      agents: { codex: proxy, claude: { ...proxy, baseUrl: "https://api.zeros.build/v2/cloud/proxy/anthropic" }, cursor: { apiKey: "key" } },
    };
    expect(CloudV2ControlFrameSchema.parse(config).t).toBe("config");
    expect(CloudV2ControlFrameSchema.safeParse({ ...config, agents: { codex: { ...proxy, refreshToken: "r" } } }).success).toBe(false);
  });
});
