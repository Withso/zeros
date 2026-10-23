// Mirror of packages/protocol/src/cloud-v2-relay.ts for the standalone zod 3
// control plane. Contract parity is tested without a runtime package import.
import { z } from "zod";

export const CLOUD_V2_RELAY_PROTOCOL = 2;
export const CLOUD_V2_WORKER_PORT = 41783;
export const CLOUD_V2_WORKER_BRIDGE_PATH = "/v2/worker/bridge";
export const CLOUD_V2_WORKER_BRIDGE_PROTOCOL = "zeros.cloud.v2.worker";
export const CLOUD_V2_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Rows per history frame; larger backfills are split by the sender. */
export const CLOUD_V2_MAX_HISTORY_ROWS = 500;

export const CloudV2AgentSchema = z.enum(["codex", "claude", "cursor"]);
export type CloudV2Agent = z.infer<typeof CloudV2AgentSchema>;

/** What the shared UI may show. Cloud v2 never offers Design, the browser or
 * simulators; the UI gates those tabs on this object, not on placement. */
export const CloudV2CapabilitiesSchema = z.object({
  design: z.literal(false),
  browser: z.literal(false),
  simulators: z.literal(false),
  terminal: z.boolean(),
  files: z.boolean(),
  git: z.boolean(),
  agents: z.array(CloudV2AgentSchema).max(3),
}).strict();
export type CloudV2Capabilities = z.infer<typeof CloudV2CapabilitiesSchema>;

const clientId = z.string().uuid();
/** One bridge frame, opaque to the relay. Both ends parse it with ./schemas. */
const frame = z.unknown();

/** The same row Local persists from `applyUpdate` (engine db/messages). */
export const CloudV2MessageRowSchema = z.object({
  msgId: z.string().min(1).max(256),
  kind: z.string().max(64),
  payload: z.string().max(1_000_000),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type CloudV2MessageRow = z.infer<typeof CloudV2MessageRowSchema>;

/** A chat row as `chats.list` returns it; validated by its readers. */
const chatRow = z.object({ id: z.string().min(1).max(256) }).passthrough();

/** Durable mirror so the app can read history while the VM sleeps. */
export const CloudV2HistoryFrameSchema = z.object({
    t: z.literal("history"),
    chats: z.array(chatRow).max(CLOUD_V2_MAX_HISTORY_ROWS).optional(),
    chatDeletions: z.array(z.string().min(1).max(256)).max(CLOUD_V2_MAX_HISTORY_ROWS).optional(),
    messages: z.object({
      chatId: z.string().min(1).max(256),
      rows: z.array(CloudV2MessageRowSchema).max(CLOUD_V2_MAX_HISTORY_ROWS),
    }).strict().optional(),
  }).strict();

export const CloudV2WorkerFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocol: z.literal(CLOUD_V2_RELAY_PROTOCOL),
    workerVersion: z.string().min(1).max(64),
    capabilities: CloudV2CapabilitiesSchema,
  }).strict(),
  /** `"*"` reaches every attached app connection. */
  z.object({ t: z.literal("frame"), clientId: z.union([clientId, z.literal("*")]), frame }).strict(),
  CloudV2HistoryFrameSchema,
  /** Idle means no running agent turn or recent terminal activity. */
  z.object({ t: z.literal("idle"), idle: z.boolean() }).strict(),
  z.object({ t: z.literal("request"), id: z.string().uuid(), kind: z.literal("github-token") }).strict(),
  z.object({ t: z.literal("stop-ack"), id: z.string().uuid() }).strict(),
]);
export type CloudV2WorkerFrame = z.infer<typeof CloudV2WorkerFrameSchema>;

const proxy = z.object({ baseUrl: z.string().url(), token: z.string().min(16).max(4096), expiresAt: z.number().int() }).strict();
const secret = z.string().min(16).max(16384);

export const CloudV2ControlFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("open"), clientId }).strict(),
  z.object({ t: z.literal("close"), clientId }).strict(),
  z.object({ t: z.literal("frame"), clientId, frame }).strict(),
  z.object({ t: z.literal("stop"), id: z.string().uuid() }).strict(),
  /** Sent after hello and again before any proxy token expires or a login
   * changes. HTTPS revision polling repairs a missed push. The control plane
   * owns proxy token refresh. */
  z.object({
    t: z.literal("config"),
    loginRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    workspace: z.object({
      id: z.string().uuid(),
      organizationId: z.string().uuid(),
      checkoutPath: z.string().min(1).max(1024),
      repository: z.string().min(1).max(512),
      /** The workspace branch; created from `baseBranch` on first boot. */
      branch: z.string().min(1).max(255),
      baseBranch: z.string().min(1).max(255),
    }).strict(),
    agents: z.object({
      codex: proxy.optional(),
      claude: z.union([z.object({ oauthToken: secret }).strict(), z.object({ apiKey: secret }).strict()]).optional(),
      cursor: z.object({ apiKey: z.string().min(1).max(4096) }).strict().optional(),
    }).strict(),
  }).strict(),
  z.object({ t: z.literal("reply"), id: z.string().uuid(), token: z.string().min(1).max(8192), expiresAt: z.number().int() }).strict(),
  z.object({ t: z.literal("refusal"), id: z.string().uuid(), code: z.string().min(1).max(64) }).strict(),
]);
export type CloudV2ControlFrame = z.infer<typeof CloudV2ControlFrameSchema>;

/** Worker-only HTTPS inputs. Bearer tokens scope them to one workspace; the
 * boot id fences a prior process after wake. History retries reuse sequence. */
export const CloudV2WorkerHelloSchema = z.object({
  protocol: z.literal(CLOUD_V2_RELAY_PROTOCOL),
  runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/), bootId: z.string().uuid(),
}).strict();
export const CloudV2WorkerHistorySchema = CloudV2HistoryFrameSchema.extend({ bootId: z.string().uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const CloudV2WorkerActivitySchema = z.object({ idle: z.boolean() }).strict();
export const CloudV2WorkerActivityReplySchema = z.object({
  loginRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  state: z.enum(["creating", "starting", "running", "stopping", "stopped", "failed", "deleting", "deleted"]),
}).strict();
