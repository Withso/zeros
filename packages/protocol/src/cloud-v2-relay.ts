// Cloud workspace v2 relay contract.
//
// The Mac app speaks ordinary bridge frames (./messages) to the control plane,
// which forwards them verbatim to the workspace worker on its Boat VM. This file
// defines only the envelope between the control plane and the worker, plus the
// capabilities the shared UI reads to hide tabs a cloud workspace does not offer.
// The control plane mirrors these schemas (it deploys independently, on zod 3).
import { z } from "zod";
import { MAX_BRIDGE_FRAME_BYTES } from "./schemas";

export const CLOUD_V2_RELAY_PROTOCOL = 2;
export const CLOUD_V2_WORKER_PORT = 41783;
export const CLOUD_V2_WORKER_BRIDGE_PATH = "/v2/worker/bridge";
export const CLOUD_V2_WORKER_BRIDGE_PROTOCOL = "zeros.cloud.v2.worker";
export const CLOUD_V2_MAX_FRAME_BYTES = MAX_BRIDGE_FRAME_BYTES;
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
  promptOutbox: z.literal(1).optional(),
  /** Configuration delivery is sent only after a worker advertises this version. */
  mcp: z.literal(1).optional(),
}).strict();
export type CloudV2Capabilities = z.infer<typeof CloudV2CapabilitiesSchema>;

const clientId = z.uuid();
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
const chatRow = z.object({ id: z.string().min(1).max(256) }).loose();

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
  z.object({ t: z.literal("request"), id: z.uuid(), kind: z.literal("github-token") }).strict(),
  z.object({ t: z.literal("stop-ack"), id: z.uuid() }).strict(),
]);
export type CloudV2WorkerFrame = z.infer<typeof CloudV2WorkerFrameSchema>;

const proxy = z.object({ baseUrl: z.url(), token: z.string().min(16).max(4096), expiresAt: z.number().int() }).strict();
const secret = z.string().min(16).max(16384);

const mcpValues = z.record(z.string().min(1).max(256), z.string().max(16384))
  .refine(value => Object.keys(value).length <= 128, "Too many MCP values");
const mcpIdentity = { id: z.uuid(), name: z.string().min(1).max(128) };
/** Private delivery only. These values must never enter history or diagnostics. */
export const RuntimeMcpServerSchema = z.discriminatedUnion("transport", [
  z.object({ ...mcpIdentity, transport: z.literal("stdio"), command: z.string().min(1).max(4096),
    args: z.array(z.string().max(8192)).max(128).optional(), cwd: z.string().max(4096).optional(),
    env: mcpValues.optional(), listen_url: z.string().min(1).max(4096).optional(),
  }).strict(),
  ...(["http", "sse"] as const).map(transport => z.object({ ...mcpIdentity, transport: z.literal(transport),
    url: z.string().min(1).max(4096), headers: mcpValues.optional(), auth: z.enum(["none", "header", "oauth"]).optional(),
    disabled_tools: z.array(z.string().min(1).max(256)).max(1024).optional(),
  }).strict()),
]);
export type RuntimeMcpServer = z.infer<typeof RuntimeMcpServerSchema>;

export const CloudV2ControlFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("prompts") }).strict(),
  z.object({ t: z.literal("open"), clientId }).strict(),
  z.object({ t: z.literal("close"), clientId }).strict(),
  z.object({ t: z.literal("frame"), clientId, frame }).strict(),
  z.object({ t: z.literal("stop"), id: z.uuid() }).strict(),
  /** Sent after hello and again before any proxy token expires or a login
   * changes. HTTPS revision polling repairs a missed push. The control plane
   * owns proxy token refresh. */
  z.object({
    t: z.literal("config"),
    promptOutbox: z.literal(1).optional(),
    loginRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    mcpServers: z.array(RuntimeMcpServerSchema).max(128).optional(),
    workspace: z.object({
      id: z.uuid(),
      organizationId: z.uuid(),
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
  z.object({ t: z.literal("reply"), id: z.uuid(), token: z.string().min(1).max(8192), expiresAt: z.number().int() }).strict(),
  z.object({ t: z.literal("refusal"), id: z.uuid(), code: z.string().min(1).max(64) }).strict(),
]);
export type CloudV2ControlFrame = z.infer<typeof CloudV2ControlFrameSchema>;

/** Worker-only HTTPS inputs. Bearer tokens scope them to one workspace; the
 * boot id fences a prior process after wake. History retries reuse sequence. */
export const CloudV2WorkerHelloSchema = z.object({
  protocol: z.literal(CLOUD_V2_RELAY_PROTOCOL),
  runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/), bootId: z.uuid(),
}).strict();
export const CloudV2WorkerHistorySchema = CloudV2HistoryFrameSchema.extend({ bootId: z.uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const CloudV2WorkerActivitySchema = z.object({ idle: z.boolean() }).strict();
export const CloudV2WorkerActivityReplySchema = z.object({
  loginRevision: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  state: z.enum(["creating", "starting", "running", "stopping", "stopped", "failed", "deleting", "deleted"]),
}).strict();

/** Optional diagnostics travel on their own HTTPS endpoint, never in a strict
 * hello/history frame. No command, path, provider output or credential values. */
export const CloudV2WorkerTimingSchema = z.object({
  phase: z.enum(["worker_checkout", "worker_checkout_fetch", "worker_checkout_switch", "worker_session_store", "worker_services", "worker_configure"]),
  durationMs: z.number().int().nonnegative().max(3_600_000),
}).strict();
export type CloudV2WorkerTiming = z.infer<typeof CloudV2WorkerTimingSchema>;
