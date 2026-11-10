import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CloudV2ControlFrameSchema } from "./contract.js";
import { CloudV2PromptDeliverySchema, CloudV2PromptReceiptSchema, CloudV2PromptSchema } from "./prompt-contract.js";
import { CloudEnvironmentMaterialSchema, isCloudReservedEnvironmentName } from "./environment-contract.js";
import { isCloudV2Token, newCloudV2Token } from "./tokens.js";

describe("cloud workspace API boundaries", () => {
  it("keeps session names beside the strict prompt payload and optional for N-1 delivery", () => {
    const payload = { chatId: "chat", userMessageId: "message", agentId: "codex", prompt: [{ type: "text", text: "Hello" }], startedAt: 1 };
    const delivery = { payload, deliveryId: randomUUID(), receipt: { workspaceId: randomUUID(), chatId: "chat", userMessageId: "message",
      sequence: "1", epoch: "0", acceptedAt: new Date(0).toISOString(), workspaceState: "running" } };
    const legacy = z.object({ receipt: CloudV2PromptReceiptSchema, payload: CloudV2PromptSchema, deliveryId: z.string().uuid() }).strict();
    expect(CloudV2PromptDeliverySchema.parse(delivery)).toEqual(legacy.parse(delivery));
    expect(CloudV2PromptDeliverySchema.parse({ ...delivery, sessionName: "  Task  " })).toEqual({ ...delivery, sessionName: "  Task  " });
    expect(legacy.safeParse({ ...delivery, sessionName: "Task" }).success).toBe(false);
    expect(CloudV2PromptSchema.safeParse({ ...payload, sessionName: "Task" }).success).toBe(false);
    for (const sessionName of [null, "", "   ", "x".repeat(121), "line\nbreak", "control\u0085char", "Task\n", "\tTask"])
      expect(CloudV2PromptDeliverySchema.safeParse({ ...delivery, sessionName }).success).toBe(false);
  });

  it("keeps only the explicit user API key override available in environment settings", () => {
    const material = { variables: { ZEROS_API_KEY: "synthetic-user-key" }, files: [] };
    expect(CloudEnvironmentMaterialSchema.safeParse(material).success).toBe(true);
    for (const name of ["ZEROS_API_URL", "ZEROS_API_TOKEN", "ZEROS_WORKSPACE_ID", "ZEROS_SESSION_ID"]) {
      expect(isCloudReservedEnvironmentName(name)).toBe(true);
      expect(CloudEnvironmentMaterialSchema.safeParse({ ...material, variables: { [name]: "synthetic" } }).success).toBe(false);
    }
    expect(isCloudReservedEnvironmentName("ZEROS_WORKER_TOKEN")).toBe(true);
  });

  it("validates the optional API configuration without changing legacy config acceptance", () => {
    const legacy = { t: "config", loginRevision: "0", agents: {}, workspace: {
      id: randomUUID(), organizationId: randomUUID(), repository: "fixture/repo",
      branch: "zeros/work", baseBranch: "main", checkoutPath: "/home/user/fixture/repo",
    } };
    const { token } = newCloudV2Token("api");
    expect(isCloudV2Token(token, "api")).toBe(true);
    expect(isCloudV2Token(token, "proxy")).toBe(false);
    expect(CloudV2ControlFrameSchema.safeParse(legacy).success).toBe(true);
    expect(CloudV2ControlFrameSchema.safeParse({ ...legacy, api: { url: "https://api.example.test/api/v0", token } }).success).toBe(true);
    for (const api of [
      { url: "http://api.example.test/api/v0", token },
      { url: "https://api.example.test/" + "x".repeat(2048), token },
      { url: "https://api.example.test/api/v0", token: "invalid" },
      { url: "https://api.example.test/api/v0", token: newCloudV2Token("proxy").token },
    ]) expect(CloudV2ControlFrameSchema.safeParse({ ...legacy, api }).success).toBe(false);
  });
});
