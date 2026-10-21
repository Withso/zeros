// Control-plane mirror of packages/protocol/src/cloud-v2-relay.ts. The control
// plane deploys independently (zod 3), so the envelope is restated here and a
// parity test keeps the two in step. Bridge frames stay opaque: the relay never
// interprets agent or workspace traffic it forwards.
import { z } from "zod";

export const CLOUD_V2_RELAY_PROTOCOL = 1;
export const CLOUD_V2_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const CLOUD_V2_MAX_HISTORY_ROWS = 500;

const agent = z.enum(["codex", "claude", "cursor"]);
export const CloudV2CapabilitiesSchema = z.object({
  design: z.literal(false),
  browser: z.literal(false),
  simulators: z.literal(false),
  terminal: z.boolean(),
  files: z.boolean(),
  git: z.boolean(),
  agents: z.array(agent).max(3),
}).strict();
export type CloudV2Capabilities = z.infer<typeof CloudV2CapabilitiesSchema>;

const clientId = z.string().uuid();
const frame = z.unknown();

export const CloudV2MessageRowSchema = z.object({
  msgId: z.string().min(1).max(256),
  kind: z.string().max(64),
  payload: z.string().max(1_000_000),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type CloudV2MessageRow = z.infer<typeof CloudV2MessageRowSchema>;

const chatRow = z.object({ id: z.string().min(1).max(256) }).passthrough();

export const CloudV2WorkerFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocol: z.literal(CLOUD_V2_RELAY_PROTOCOL),
    workerVersion: z.string().min(1).max(64),
    capabilities: CloudV2CapabilitiesSchema,
  }).strict(),
  z.object({ t: z.literal("frame"), clientId: z.union([clientId, z.literal("*")]), frame }).strict(),
  z.object({
    t: z.literal("history"),
    chats: z.array(chatRow).max(CLOUD_V2_MAX_HISTORY_ROWS).optional(),
    chatDeletions: z.array(z.string().min(1).max(256)).max(CLOUD_V2_MAX_HISTORY_ROWS).optional(),
    messages: z.object({
      chatId: z.string().min(1).max(256),
      rows: z.array(CloudV2MessageRowSchema).max(CLOUD_V2_MAX_HISTORY_ROWS),
    }).strict().optional(),
  }).strict(),
  z.object({ t: z.literal("idle"), idle: z.boolean() }).strict(),
  z.object({ t: z.literal("request"), id: z.string().uuid(), kind: z.literal("github-token") }).strict(),
]);
export type CloudV2WorkerFrame = z.infer<typeof CloudV2WorkerFrameSchema>;

export type CloudV2Proxy = { baseUrl: string; token: string; expiresAt: number };
export type CloudV2ControlFrame =
  | { t: "open"; clientId: string }
  | { t: "close"; clientId: string }
  | { t: "frame"; clientId: string; frame: unknown }
  | {
      t: "config";
      workspace: { id: string; organizationId: string; checkoutPath: string; repository: string; branch: string; baseBranch: string };
      agents: { codex?: CloudV2Proxy; claude?: { oauthToken: string } | { apiKey: string }; cursor?: { apiKey: string } };
    }
  | { t: "reply"; id: string; token: string; expiresAt: number }
  | { t: "refusal"; id: string; code: string };
