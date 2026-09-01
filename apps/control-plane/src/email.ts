// ──────────────────────────────────────────────────────────
// Outbound product email — Resend HTTPS API.
//
// Hosted AuthKit owns authentication and native organization-invitation
// emails in WorkOS mode. This independent sender remains for Zeros-specific
// security/account-lifecycle notifications and the Auth0 invitation rollback
// path. Config:
//   RESEND_API_KEY  — environment-specific, sending-only Resend API key
//   EMAIL_FROM      — verified sender, e.g.
//                     "Zeros <notifications@updates.zeros.build>"
// Unset → dev fallback: the message is logged, never sent, and the API
// still succeeds; callers decide whether an unsent message is acceptable.
// ──────────────────────────────────────────────────────────

// Keep the credential destination pinned. A configurable provider URL could
// turn one environment-variable mistake into API-key exfiltration.
const RESEND_EMAIL_API = "https://api.resend.com/emails";
const RESEND_USER_AGENT = "zeros-control-plane/0.1";

export type EmailConfig = {
  apiKey: string | null;
  from: string | null;
};

export type EmailSendOptions = {
  /** Resend retains this provider idempotency key for 24 hours. */
  idempotencyKey?: string;
  fetch?: typeof fetch;
};

export type EmailDeliveryReceipt = {
  provider: "resend";
  messageId: string;
};

export class EmailDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "EmailDeliveryError";
  }
}

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const apiKey = env.RESEND_API_KEY?.trim() || null;
  const rawFrom = env.EMAIL_FROM?.trim() || null;
  // Resend accepts a formatted mailbox string. Reject newline-bearing values
  // locally rather than relying on a provider-side header-injection check.
  const from = rawFrom && !/[\r\n]/.test(rawFrom) ? rawFrom : null;
  return { apiKey, from };
}

export async function sendEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  htmlBody: string,
  options: EmailSendOptions = {},
): Promise<void> {
  if (!config.apiKey || !config.from) {
    console.log(
      `[email:dev-fallback] subject=${JSON.stringify(subject)} (RESEND_API_KEY/EMAIL_FROM unset — not sent)`,
    );
    return;
  }
  try {
    await sendEmailStrict(config, to, subject, htmlBody, options);
  } catch (error) {
    // Deliberately NOT thrown to the invitation request — the invitation row
    // exists and the admin got the copyable link. Security notifications use
    // sendEmailStrict through their durable outbox instead.
    const delivery =
      error instanceof EmailDeliveryError
        ? `${error.code}${error.status ? ` status=${error.status}` : ""}`
        : error instanceof Error
          ? error.name
          : "unknown";
    console.error(`[email] delivery failed: ${delivery}`);
  }
}

export async function sendEmailStrict(
  config: EmailConfig,
  to: string,
  subject: string,
  htmlBody: string,
  options: EmailSendOptions = {},
): Promise<EmailDeliveryReceipt> {
  if (!config.apiKey || !config.from) {
    throw new EmailDeliveryError("email_not_configured", true);
  }
  if (
    options.idempotencyKey !== undefined &&
    !/^[A-Za-z0-9._:/-]{1,256}$/.test(options.idempotencyKey)
  ) {
    throw new EmailDeliveryError("email_reference_invalid", false);
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(RESEND_EMAIL_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": RESEND_USER_AGENT,
        ...(options.idempotencyKey
          ? { "idempotency-key": options.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        from: config.from,
        to: [to],
        subject,
        html: htmlBody,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error;
    throw new EmailDeliveryError(
      error instanceof Error && error.name === "TimeoutError"
        ? "email_timeout"
        : "email_network_error",
      true,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  const rawProviderType =
    payload && typeof payload === "object"
      ? "name" in payload && typeof payload.name === "string"
        ? payload.name
        : "type" in payload && typeof payload.type === "string"
          ? payload.type
          : null
      : null;
  const providerType = rawProviderType
    ? rawProviderType.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64)
    : null;
  if (!response.ok) {
    const retryableConflict =
      response.status === 409 &&
      (providerType === "concurrent_idempotent_requests" ||
        providerType === "resource_locked");
    throw new EmailDeliveryError(
      `resend_${response.status}${providerType ? `_${providerType}` : ""}`,
      retryableConflict ||
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
      response.status,
    );
  }
  const messageId =
    payload &&
    typeof payload === "object" &&
    "id" in payload &&
    typeof payload.id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(payload.id)
      ? payload.id
      : null;
  if (!messageId) {
    // The provider may have accepted the request before its response was
    // corrupted. Retrying with the same key is safe within Resend's 24-hour
    // idempotency window and returns the original message identifier.
    throw new EmailDeliveryError(
      "resend_response_invalid",
      true,
      response.status,
    );
  }
  return { provider: "resend", messageId };
}

/** The invitation email. Plain, robust HTML (no images, no CSS frameworks —
 *  invite mail must survive every client). */
export function inviteEmailHtml(opts: {
  organizationName: string;
  inviterName: string;
  acceptUrl: string;
  expiresDays: number;
}): { subject: string; html: string } {
  const subject = `${opts.inviterName} invited you to ${opts.organizationName} on Zeros`;
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1b22;line-height:1.6;max-width:520px;margin:0 auto;padding:32px 20px">
  <h2 style="margin:0 0 16px;font-size:20px">Join ${escapeHtml(opts.organizationName)} on Zeros</h2>
  <p style="margin:0 0 20px">${escapeHtml(opts.inviterName)} invited you to collaborate in <b>${escapeHtml(opts.organizationName)}</b>.</p>
  <p style="margin:0 0 28px">
    <a href="${escapeAttr(opts.acceptUrl)}"
       style="background:#1b1b22;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">
      Accept invitation
    </a>
  </p>
  <p style="margin:0 0 6px;color:#6b7280;font-size:13px">This link is personal to you and expires in ${opts.expiresDays} days.</p>
  <p style="margin:0;color:#6b7280;font-size:13px">If the button doesn't work, paste this into your browser:<br>
    <span style="word-break:break-all">${escapeHtml(opts.acceptUrl)}</span></p>
</body></html>`;
  return { subject, html };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
