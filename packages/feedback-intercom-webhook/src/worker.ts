// ──────────────────────────────────────────────────────────
// Feedback → Intercom bridge (Cloudflare Worker)
// ──────────────────────────────────────────────────────────
//
// The app's Help → Feedback modal posts here; this Worker creates an Intercom
// contact + a user-initiated conversation (type-prefixed) so it lands in the
// Intercom Inbox as a thread FROM the user:
//
//   Feedback modal → this Worker → Intercom (contact + conversation)
//     → Intercom Inbox → (native "Create with Linear Agent") → Linear
//                    ↘ Linear issue DIRECTLY (issueCreate + log attachment)
//                      when LINEAR_API_KEY + LINEAR_TEAM_ID are configured
//
// The type (Issue / Bug / Feature request / Feedback) is the "tag": always a
// prefix on the conversation body (zero Intercom setup, read by the AI agent),
// and ALSO a real Intercom tag when INTERCOM_ADMIN_ID + INTERCOM_TAG_IDS are set.
//
// Logs: the app sends its secret-scrubbed recent JSONL tail (≤ MAX_LOGS).
// Intercom's conversation body only gets the last MAX_INTERCOM_LOGS chars
// (inbox readability); Linear gets the FULL payload — uploaded as a .jsonl
// attachment via the fileUpload mutation, falling back to a fenced tail in
// the issue description if the upload fails. Both destinations are
// best-effort and independent: the submission succeeds if EITHER lands.
//
// Privacy: the renderer scrubs "recent logs" (via @zeros/core/scrub) BEFORE
// posting. The Worker forwards + truncates defensively; it never un-scrubs and
// adds nothing sensitive of its own.
//
// AUTH: a verified Auth0 access token, and the sender's identity comes from
// that token's claims — never from the request body.
//
// This replaced a shared secret. The secret was compiled into every published
// build, so once the repo went public anyone could extract it from a DMG; and
// because the sender's address was just a body field, holding it let you file
// feedback as ANY email, which the Worker then attached to a real Intercom
// contact. That is inbox impersonation, not merely spam. A secret shipped
// inside the client it authenticates was never an auth boundary — the fix is
// to authenticate the USER, which also means the address in Intercom is one
// Auth0 actually verified.
// ──────────────────────────────────────────────────────────

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  /** Auth0 tenant domain, no scheme (e.g. "tenant.us.auth0.com"). The JWKS URL
   *  and the expected issuer are both derived from it. */
  AUTH0_DOMAIN: string;
  /** Auth0 API identifier this Worker accepts tokens for — must match the
   *  audience the app requests, and the backend's AUTH_AUDIENCE. */
  AUTH_AUDIENCE: string;
  /** Per-IP rate-limit binding (declared in wrangler.jsonc). */
  FEEDBACK_LIMITER?: RateLimiter;
  /** Intercom access token (Developer Hub → your app). */
  INTERCOM_TOKEN: string;
  /** Intercom data region: "us" (default) | "eu" | "au". */
  INTERCOM_REGION?: string;
  /** Optional — an admin id; enables applying a real Intercom tag. */
  INTERCOM_ADMIN_ID?: string;
  /** Optional — JSON map of type → Intercom tag id, e.g. {"bug":"123"}. */
  INTERCOM_TAG_IDS?: string;
  /** Optional — Intercom workspace app id, for a clickable conversation link
   *  in the Linear issue. */
  INTERCOM_APP_ID?: string;
  /** Optional — Linear personal API key; enables direct issue creation. */
  LINEAR_API_KEY?: string;
  /** Required with LINEAR_API_KEY — the team the issues land in. */
  LINEAR_TEAM_ID?: string;
  /** Optional — JSON map of type → Linear label id, e.g. {"bug":"…uuid…"}. */
  LINEAR_LABEL_IDS?: string;
  /** Optional — PostHog project URL (e.g. https://us.posthog.com/project/123)
   *  for a clickable person link from posthog_distinct_id. */
  POSTHOG_PROJECT_URL?: string;
}

// Deliberately NO `email` / `name` / `token` fields. Identity is read from the
// verified access token; accepting it from the body is exactly the
// impersonation hole this endpoint used to have, and a field that does not
// exist cannot be reintroduced by accident.
interface FeedbackPayload {
  /** "issue" | "bug" | "feature" | "feedback". */
  type?: string;
  message?: string;
  app_version?: string;
  area?: string;
  /** Optional deep-link back to a related PostHog person/issue. */
  posthog_url?: string;
  /** Optional anonymous PostHog distinct id — combined with
   *  POSTHOG_PROJECT_URL into a person link. */
  posthog_distinct_id?: string;
  /** Optional recent app logs — ALREADY scrubbed client-side. */
  logs?: string;
}

const INTERCOM_VERSION = "2.14";
/** Full log payload cap (~500 KB — the same ceiling the app applies before it
 *  sends; kept whole for Linear's attachment). */
const MAX_LOGS = 500_000;
/** Inbox-readable tail shown inline in the Intercom conversation. */
const MAX_INTERCOM_LOGS = 6000;
/** Fenced tail embedded in the Linear description when the upload fails. */
const MAX_LINEAR_INLINE_LOGS = 20_000;
const MAX_MESSAGE = 8000;

const TYPE_LABEL: Record<string, string> = {
  issue: "Issue",
  bug: "Bug",
  feature: "Feature request",
  feedback: "Feedback",
};

function apiBase(region?: string): string {
  switch ((region || "us").toLowerCase()) {
    case "eu":
      return "https://api.eu.intercom.io";
    case "au":
      return "https://api.au.intercom.io";
    default:
      return "https://api.intercom.io";
  }
}

// The renderer posts cross-origin (app.zeros.build → workers.dev, and Electron's
// Chromium renderer enforces CORS too); allow any origin since the verified
// access token — not the origin — is what authorizes the call. A hostile page
// gains nothing from reaching this endpoint: without a token minted for THIS
// audience it gets a 401, and with one it can only file feedback as its own
// signed-in user.
const CORS = { "access-control-allow-origin": "*" } as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

function text(message: string, status: number): Response {
  return new Response(message, { status, headers: { ...CORS } });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function intercom(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(apiBase(env.INTERCOM_REGION) + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.INTERCOM_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json",
      "intercom-version": INTERCOM_VERSION,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Intercom ${path} ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ── Linear (direct issue creation) ────────────────────────

const LINEAR_GQL = "https://api.linear.app/graphql";

async function linearGql(
  env: Env,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: {
      // Personal API keys are sent bare (no "Bearer" prefix).
      authorization: env.LINEAR_API_KEY!,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: { message?: string }[];
  };
  if (!res.ok || data.errors?.length) {
    throw new Error(
      `Linear GraphQL ${res.status}: ${data.errors?.[0]?.message ?? "unknown error"}`,
    );
  }
  return data.data ?? {};
}

/** Upload the full log payload as a Linear file asset. Returns the asset URL
 *  to reference from the issue description, or null when any step fails (the
 *  caller falls back to an inline tail). */
async function uploadLogsToLinear(env: Env, logs: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(logs);
    const data = await linearGql(
      env,
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
    const upload = (data.fileUpload as {
      uploadFile?: {
        uploadUrl?: string;
        assetUrl?: string;
        headers?: { key: string; value: string }[];
      };
    })?.uploadFile;
    if (!upload?.uploadUrl || !upload.assetUrl) return null;
    const headers: Record<string, string> = {
      "content-type": "application/x-ndjson",
    };
    for (const h of upload.headers ?? []) headers[h.key] = h.value;
    const put = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers,
      body: bytes,
    });
    return put.ok ? upload.assetUrl : null;
  } catch {
    return null;
  }
}

interface LinearIssueRef {
  identifier: string;
  url: string;
}

/** Create the Linear issue: typed title, metadata block, and the logs —
 *  attached as a .jsonl asset when the upload works, inline tail otherwise. */
async function createLinearIssue(
  env: Env,
  input: {
    label: string;
    type: string;
    message: string;
    appVersion?: string;
    area?: string;
    email?: string;
    posthogLink?: string;
    intercomConvoId?: string;
    logs: string;
  },
): Promise<LinearIssueRef | null> {
  const title = `[${input.label}] ${input.message.replace(/\s+/g, " ").slice(0, 80)}`;

  const intercomLink = input.intercomConvoId
    ? env.INTERCOM_APP_ID
      ? `[conversation ${input.intercomConvoId}](https://app.intercom.com/a/apps/${env.INTERCOM_APP_ID}/inbox/inbox/all/conversations/${input.intercomConvoId})`
      : `conversation ${input.intercomConvoId}`
    : "";
  const meta = [
    input.appVersion ? `**App:** ${input.appVersion}` : "",
    input.area ? `**Area:** ${input.area}` : "",
    input.email ? `**Email:** ${input.email}` : "",
    input.posthogLink ? `**PostHog:** ${input.posthogLink}` : "",
    intercomLink ? `**Intercom:** ${intercomLink}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let logsSection = "";
  if (input.logs) {
    const assetUrl = await uploadLogsToLinear(env, input.logs);
    logsSection = assetUrl
      ? `\n\n### Recent app logs (scrubbed)\n[zeros-feedback-logs.jsonl](${assetUrl})`
      : `\n\n### Recent app logs (scrubbed, tail)\n\`\`\`\n${input.logs.slice(-MAX_LINEAR_INLINE_LOGS)}\n\`\`\``;
  }

  const description = `${input.message}\n\n${meta}${logsSection}`;

  let labelIds: string[] | undefined;
  if (env.LINEAR_LABEL_IDS) {
    try {
      const map = JSON.parse(env.LINEAR_LABEL_IDS) as Record<string, string>;
      if (map[input.type]) labelIds = [map[input.type]];
    } catch {
      /* label map malformed — issue still gets created */
    }
  }

  const data = await linearGql(
    env,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier url } }
    }`,
    {
      input: {
        teamId: env.LINEAR_TEAM_ID,
        title,
        description,
        ...(labelIds ? { labelIds } : {}),
      },
    },
  );
  const issue = (data.issueCreate as { issue?: LinearIssueRef })?.issue;
  return issue ?? null;
}

// Auth0 access tokens carry NO profile claims by default; a Post-Login Action
// stamps them on, and Auth0 requires custom claims to be NAMESPACED (it
// silently drops a plain `email`). Read the namespaced claim first and fall
// back to top-level so a differently-shaped token still resolves. This NS must
// stay in sync with the Action AND with backend/src/auth.ts.
const CLAIM_NS = "https://zeros.build/";

function claimString(payload: JWTPayload, key: string): string | null {
  const ns = payload[CLAIM_NS + key];
  if (typeof ns === "string") return ns;
  const top = payload[key];
  return typeof top === "string" ? top : null;
}

function claimBool(payload: JWTPayload, key: string): boolean | undefined {
  const ns = payload[CLAIM_NS + key];
  if (typeof ns === "boolean") return ns;
  const top = payload[key];
  return typeof top === "boolean" ? top : undefined;
}

// One JWKS per isolate. createRemoteJWKSet caches keys and coalesces fetches
// internally, so hoisting it out of the request path is what keeps a burst of
// submissions from becoming a burst of JWKS fetches. Keyed by URL so a config
// change can't be served by a stale key set.
let jwksCache: { url: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;
function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache || jwksCache.url !== url) {
    jwksCache = { url, set: createRemoteJWKSet(new URL(url)) };
  }
  return jwksCache.set;
}

export interface Sender {
  sub: string;
  email: string;
  name: string | null;
}

/** Verify the bearer token and return the VERIFIED sender, or null. Every
 *  rejection is the same null → one opaque 401, so this can never become an
 *  oracle for which tokens/tenants/addresses exist. */
async function verifySender(req: Request, env: Env): Promise<Sender | null> {
  if (!env.AUTH0_DOMAIN || !env.AUTH_AUDIENCE) return null;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  const domain = env.AUTH0_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(
      token,
      jwksFor(`https://${domain}/.well-known/jwks.json`),
      {
        issuer: `https://${domain}/`,
        audience: env.AUTH_AUDIENCE,
        // The remote JWKS only yields RS256 keys, but pin it anyway: an
        // unpinned alg is how `none`/HS-confusion attacks get in.
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
      },
    ));
  } catch {
    return null;
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email = claimString(payload, "email");
  if (!sub || !email) return null;
  // Fail CLOSED on a missing claim, not just a false one: an absent
  // email_verified means a misconfigured connection, not a trustworthy token,
  // and this address is about to become an Intercom contact. Mirrors
  // backend/src/auth.ts.
  if (claimBool(payload, "email_verified") !== true) return null;

  return {
    sub,
    email,
    name: claimString(payload, "name") || claimString(payload, "nickname"),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight — the web build posts cross-origin from app.zeros.build.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "POST") {
      return text("Method Not Allowed", 405);
    }

    // Per-IP rate limit BEFORE auth — an unauthenticated caller must not be
    // able to make us do JWKS work or burn CPU on signature checks, and a
    // signed-in user must not be able to flood the inbox. Fails OPEN only if
    // the binding itself is unavailable, never on a real limit hit.
    if (env.FEEDBACK_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      try {
        const { success } = await env.FEEDBACK_LIMITER.limit({ key: `feedback:${ip}` });
        if (!success) return text("Too Many Requests", 429);
      } catch {
        /* limiter unavailable — don't block feedback over an infra blip */
      }
    }

    const sender = await verifySender(request, env);
    if (!sender) return text("Unauthorized", 401);

    let body: FeedbackPayload;
    try {
      body = (await request.json()) as FeedbackPayload;
    } catch {
      return text("Bad Request: invalid JSON", 400);
    }

    const message = (body.message || "").trim().slice(0, MAX_MESSAGE);
    if (!message) {
      return text("Bad Request: missing message", 400);
    }
    const type = (body.type || "feedback").toLowerCase();
    const label = TYPE_LABEL[type] || "Feedback";

    // Keep the TAIL when over the cap — newest records matter most.
    const logs = (body.logs || "").slice(-MAX_LOGS);
    // A clickable PostHog person link when we can build one; otherwise pass
    // through whatever the client sent (url or bare distinct id).
    const posthogLink =
      body.posthog_url ||
      (body.posthog_distinct_id && env.POSTHOG_PROJECT_URL
        ? `${env.POSTHOG_PROJECT_URL.replace(/\/$/, "")}/persons?distinct_id=${encodeURIComponent(body.posthog_distinct_id)}`
        : body.posthog_distinct_id || "");

    // ── Destination 1: Intercom (contact + conversation + optional tag) ──
    let convoId: string | undefined;
    let intercomErr: unknown;
    try {
      // 1) Contact — always a `user` (never a `lead`): auth is mandatory, so
      //    there is always an Auth0-verified address to reply to. `external_id`
      //    pins the contact to the Auth0 subject, so two people who ever share
      //    an address cannot collapse into one Intercom identity.
      const contact = await intercom(env, "/contacts", {
        role: "user",
        external_id: sender.sub,
        email: sender.email,
        ...(sender.name ? { name: sender.name } : {}),
      });
      const contactId = contact.id as string | undefined;
      if (!contactId) throw new Error("Intercom contact create returned no id");

      // 2) User-initiated conversation. Body carries the type prefix + metadata
      //    so the Inbox and the "Create with Linear Agent" see everything. Only
      //    the readable log TAIL goes inline — the full payload rides on the
      //    Linear issue.
      const meta = [
        body.app_version ? `App ${escapeHtml(body.app_version)}` : "",
        body.area ? `Area ${escapeHtml(body.area)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const html =
        `<p><b>[${label}]</b> ${escapeHtml(message)}</p>` +
        (meta ? `<p>${meta}</p>` : "") +
        (posthogLink ? `<p>PostHog: ${escapeHtml(posthogLink)}</p>` : "") +
        (logs
          ? `<p><b>Recent logs (scrubbed, tail)</b></p><pre>${escapeHtml(logs.slice(-MAX_INTERCOM_LOGS))}</pre>`
          : "");

      const convo = await intercom(env, "/conversations", {
        // Always "user" — matches the contact role above, which is no longer
        // conditional now that every sender is authenticated.
        from: { type: "user", id: contactId },
        body: html,
      });
      convoId = (convo.id || convo.conversation_id) as string | undefined;

      // 3) Optional real Intercom tag (best-effort; needs admin id + tag map).
      if (convoId && env.INTERCOM_ADMIN_ID && env.INTERCOM_TAG_IDS) {
        try {
          const map = JSON.parse(env.INTERCOM_TAG_IDS) as Record<string, string>;
          const tagId = map[type];
          if (tagId) {
            await intercom(env, `/conversations/${convoId}/tags`, {
              id: tagId,
              admin_id: env.INTERCOM_ADMIN_ID,
            });
          }
        } catch {
          /* tagging is best-effort — never fail the submission over it */
        }
      }
    } catch (err) {
      intercomErr = err;
      console.error("[feedback-intercom] Intercom failed:", err);
    }

    // ── Destination 2: Linear (direct issue; full logs as attachment) ──
    // Independent of Intercom so a support-inbox outage doesn't lose the
    // engineering-side report (and vice versa).
    let linearIssue: LinearIssueRef | null = null;
    if (env.LINEAR_API_KEY && env.LINEAR_TEAM_ID) {
      try {
        linearIssue = await createLinearIssue(env, {
          label,
          type,
          message,
          appVersion: body.app_version,
          area: body.area,
          email: sender.email,
          posthogLink: posthogLink || undefined,
          intercomConvoId: convoId,
          logs,
        });
      } catch (err) {
        console.error("[feedback-intercom] Linear failed:", err);
      }
    }

    if (!convoId && !linearIssue) {
      const err = intercomErr;
      return text(
        `Bridge error: ${err instanceof Error ? err.message : String(err ?? "no destination configured")}`,
        502,
      );
    }
    return json(
      {
        ok: true,
        conversation: convoId ?? null,
        linear_issue: linearIssue?.identifier ?? null,
        type,
      },
      200,
    );
  },
};
