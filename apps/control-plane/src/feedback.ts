// ──────────────────────────────────────────────────────────
// Authenticated product feedback → Intercom and/or Linear.
//
// This route replaces the standalone Cloudflare feedback Worker. Authentication
// is deliberately NOT repeated here: app.ts mounts it after the control-plane
// Auth0 middleware, and sender identity comes only from c.get("user"). Body
// fields are strict so an email/name/token impersonation field cannot quietly
// return later.
// ──────────────────────────────────────────────────────────

import { Hono } from "hono";
import { z } from "zod";

import type { FeedbackBackendConfig } from "./config.js";
import { HttpError } from "./authz.js";
import {
  ACCEPTED_FEEDBACK_TYPES,
  FEEDBACK_TYPE_LABELS,
  normalizeFeedbackType,
} from "./feedback-types.js";

const INTERCOM_VERSION = "2.14";
const LINEAR_GQL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_INTERCOM_LOGS = 6_000;
const MAX_LINEAR_INLINE_LOGS = 20_000;

const HttpsUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .refine((raw) => {
    const url = new URL(raw);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  }, "must be a credential-free HTTPS URL without a fragment");

const FeedbackPayloadSchema = z
  .object({
    type: z
      .enum(ACCEPTED_FEEDBACK_TYPES)
      .default("feedback")
      .transform(normalizeFeedbackType),
    message: z.string().trim().min(1).max(8_000),
    app_version: z.string().trim().max(100).optional(),
    area: z.string().trim().max(200).optional(),
    posthog_url: HttpsUrlSchema.optional(),
    posthog_distinct_id: z.string().trim().max(512).optional(),
    // The desktop already scrubs this before transport. The server caps it
    // again; app.ts caps the whole request before JSON parsing as well.
    logs: z.string().max(500_000).optional(),
  })
  .strict();

type FeedbackPayload = z.infer<typeof FeedbackPayloadSchema>;
type IntercomConfig = NonNullable<FeedbackBackendConfig["intercom"]>;
type LinearConfig = NonNullable<FeedbackBackendConfig["linear"]>;
type JsonRecord = Record<string, unknown>;

class UpstreamError extends Error {
  constructor(
    public readonly service: "Intercom" | "Linear",
    public readonly status: number,
    detail: string,
  ) {
    super(`${service} ${status}: ${detail}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function responseJson(text: string): JsonRecord {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

function boundedDetail(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 2_000) || "empty response";
}

function intercomApiBase(region: IntercomConfig["region"]): string {
  if (region === "eu") return "https://api.eu.intercom.io";
  if (region === "au") return "https://api.au.intercom.io";
  return "https://api.intercom.io";
}

async function intercomRequest(
  config: IntercomConfig,
  method: "GET" | "POST",
  path: string,
  body?: JsonRecord,
): Promise<JsonRecord> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/json",
      "intercom-version": INTERCOM_VERSION,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body) init.body = JSON.stringify(body);

  const response = await fetch(intercomApiBase(config.region) + path, init);
  const text = await response.text();
  if (!response.ok) {
    throw new UpstreamError("Intercom", response.status, boundedDetail(text));
  }
  return responseJson(text);
}

async function findIntercomContact(
  config: IntercomConfig,
  externalId: string,
): Promise<JsonRecord | null> {
  try {
    return await intercomRequest(
      config,
      "GET",
      `/contacts/find_by_external_id/${encodeURIComponent(externalId)}`,
    );
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) return null;
    throw error;
  }
}

async function getOrCreateIntercomContact(
  config: IntercomConfig,
  sender: { providerSub: string; email: string; displayName: string | null },
): Promise<string> {
  const existing = await findIntercomContact(config, sender.providerSub);
  if (typeof existing?.id === "string" && existing.id) return existing.id;

  try {
    const created = await intercomRequest(config, "POST", "/contacts", {
      role: "user",
      external_id: sender.providerSub,
      email: sender.email,
      ...(sender.displayName ? { name: sender.displayName } : {}),
    });
    if (typeof created.id === "string" && created.id) return created.id;
    throw new Error("Intercom contact creation returned no id");
  } catch (error) {
    // Two first submissions can race. Intercom correctly rejects the second
    // create with 409; resolve the contact that the winning request created.
    if (error instanceof UpstreamError && error.status === 409) {
      const raced = await findIntercomContact(config, sender.providerSub);
      if (typeof raced?.id === "string" && raced.id) return raced.id;
    }
    throw error;
  }
}

function posthogLink(
  payload: FeedbackPayload,
  projectUrl: string | null,
): string {
  if (payload.posthog_url) return payload.posthog_url;
  if (!payload.posthog_distinct_id) return "";
  if (!projectUrl) return payload.posthog_distinct_id;
  return `${projectUrl}/persons?distinct_id=${encodeURIComponent(
    payload.posthog_distinct_id,
  )}`;
}

async function deliverToIntercom(
  config: IntercomConfig,
  sender: { providerSub: string; email: string; displayName: string | null },
  payload: FeedbackPayload,
  link: string,
): Promise<string> {
  const contactId = await getOrCreateIntercomContact(config, sender);
  const label = FEEDBACK_TYPE_LABELS[payload.type];
  const metadata = [
    payload.app_version ? `App ${escapeHtml(payload.app_version)}` : "",
    payload.area ? `Area ${escapeHtml(payload.area)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const logs = payload.logs ?? "";
  const html =
    `<p><b>[${label}]</b> ${escapeHtml(payload.message)}</p>` +
    (metadata ? `<p>${metadata}</p>` : "") +
    (link ? `<p>PostHog: ${escapeHtml(link)}</p>` : "") +
    (logs
      ? `<p><b>Recent logs (scrubbed, tail)</b></p><pre>${escapeHtml(
          logs.slice(-MAX_INTERCOM_LOGS),
        )}</pre>`
      : "");

  const conversation = await intercomRequest(config, "POST", "/conversations", {
    from: { type: "user", id: contactId },
    body: html,
  });
  const conversationId =
    typeof conversation.id === "string"
      ? conversation.id
      : typeof conversation.conversation_id === "string"
        ? conversation.conversation_id
        : null;
  if (!conversationId) {
    throw new Error("Intercom conversation creation returned no id");
  }

  const tagId = config.tagIds[payload.type];
  if (config.adminId && tagId) {
    try {
      await intercomRequest(
        config,
        "POST",
        `/conversations/${encodeURIComponent(conversationId)}/tags`,
        { id: tagId, admin_id: config.adminId },
      );
    } catch (error) {
      console.warn(
        "[feedback] Intercom tagging failed; conversation kept:",
        error,
      );
    }
  }
  return conversationId;
}

async function linearGql(
  config: LinearConfig,
  query: string,
  variables: JsonRecord,
): Promise<JsonRecord> {
  const response = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: {
      authorization: config.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const parsed = responseJson(text) as {
    data?: JsonRecord;
    errors?: { message?: string }[];
  };
  if (!response.ok || parsed.errors?.length) {
    throw new UpstreamError(
      "Linear",
      response.status,
      parsed.errors?.[0]?.message ?? boundedDetail(text),
    );
  }
  return parsed.data ?? {};
}

function validLinearUploadUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      url.hostname === "uploads.linear.app" &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

async function uploadLogsToLinear(
  config: LinearConfig,
  logs: string,
): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(logs);
    const data = await linearGql(
      config,
      `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success
          uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      {
        contentType: "application/x-ndjson",
        filename: `zeros-feedback-logs-${Date.now()}.jsonl`,
        size: bytes.length,
      },
    );
    const upload = (
      data.fileUpload as {
        uploadFile?: {
          uploadUrl?: string;
          assetUrl?: string;
          headers?: { key: string; value: string }[];
        };
      }
    )?.uploadFile;
    const uploadUrl = upload?.uploadUrl
      ? validLinearUploadUrl(upload.uploadUrl)
      : null;
    const assetUrl = upload?.assetUrl
      ? validLinearUploadUrl(upload.assetUrl)
      : null;
    if (!uploadUrl || !assetUrl) {
      throw new Error("Linear returned an invalid upload URL");
    }

    const headers: Record<string, string> = {
      "content-type": "application/x-ndjson",
      "cache-control": "public, max-age=31536000",
    };
    for (const header of upload?.headers ?? []) {
      headers[header.key] = header.value;
    }
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers,
      body: bytes,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new UpstreamError("Linear", response.status, "log upload failed");
    }
    return assetUrl.toString();
  } catch (error) {
    console.warn(
      "[feedback] Linear log upload failed; using inline tail:",
      error,
    );
    return null;
  }
}

type LinearIssueRef = { identifier: string; url: string };

async function deliverToLinear(
  config: LinearConfig,
  intercomAppId: string | null,
  senderEmail: string,
  payload: FeedbackPayload,
  link: string,
  intercomConversationId: string | null,
): Promise<LinearIssueRef> {
  const label = FEEDBACK_TYPE_LABELS[payload.type];
  const titleMessage = payload.message.replace(/\s+/g, " ").slice(0, 80);
  const intercomLink = intercomConversationId
    ? intercomAppId
      ? `[conversation ${intercomConversationId}](https://app.intercom.com/a/apps/${encodeURIComponent(
          intercomAppId,
        )}/inbox/inbox/all/conversations/${encodeURIComponent(
          intercomConversationId,
        )})`
      : `conversation ${intercomConversationId}`
    : "";
  const metadata = [
    payload.app_version ? `**App:** ${payload.app_version}` : "",
    payload.area ? `**Area:** ${payload.area}` : "",
    `**Email:** ${senderEmail}`,
    link ? `**PostHog:** ${link}` : "",
    intercomLink ? `**Intercom:** ${intercomLink}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let logsSection = "";
  if (payload.logs) {
    const assetUrl = await uploadLogsToLinear(config, payload.logs);
    logsSection = assetUrl
      ? `\n\n### Recent app logs (scrubbed)\n[zeros-feedback-logs.jsonl](${assetUrl})`
      : `\n\n### Recent app logs (scrubbed, tail)\n\`\`\`\n${payload.logs.slice(
          -MAX_LINEAR_INLINE_LOGS,
        )}\n\`\`\``;
  }

  const labelId = config.labelIds[payload.type];
  const data = await linearGql(
    config,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier url } }
    }`,
    {
      input: {
        teamId: config.teamId,
        title: `[${label}] ${titleMessage}`,
        description: `${payload.message}\n\n${metadata}${logsSection}`,
        ...(labelId ? { labelIds: [labelId] } : {}),
      },
    },
  );
  const issue = (data.issueCreate as { issue?: LinearIssueRef })?.issue;
  if (!issue?.identifier || !issue.url) {
    throw new Error("Linear issue creation returned no issue");
  }
  return issue;
}

export function createFeedbackRoutes(
  config: FeedbackBackendConfig | null,
): Hono {
  const app = new Hono();

  app.post("/v1/feedback", async (c) => {
    if (!config) {
      throw new HttpError(
        503,
        "feedback_not_configured",
        "Feedback is not configured in this environment",
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HttpError(422, "invalid_feedback", "Invalid feedback payload");
    }
    const parsed = FeedbackPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(422, "invalid_feedback", "Invalid feedback payload");
    }
    const payload = parsed.data;
    const sender = c.get("user");
    const link = posthogLink(payload, config.posthogProjectUrl);

    let conversationId: string | null = null;
    if (config.intercom) {
      try {
        conversationId = await deliverToIntercom(
          config.intercom,
          sender,
          payload,
          link,
        );
      } catch (error) {
        console.error("[feedback] Intercom delivery failed:", error);
      }
    }

    let linearIssue: LinearIssueRef | null = null;
    if (config.linear) {
      try {
        linearIssue = await deliverToLinear(
          config.linear,
          config.intercom?.appId ?? null,
          sender.email,
          payload,
          link,
          conversationId,
        );
      } catch (error) {
        console.error("[feedback] Linear delivery failed:", error);
      }
    }

    if (!conversationId && !linearIssue) {
      throw new HttpError(
        502,
        "feedback_delivery_failed",
        "Couldn't deliver feedback",
      );
    }
    return c.json({
      ok: true,
      conversation: conversationId,
      linear_issue: linearIssue?.identifier ?? null,
      type: payload.type,
    });
  });

  return app;
}
