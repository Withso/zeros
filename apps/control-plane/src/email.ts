// ──────────────────────────────────────────────────────────
// Outbound email — ZeptoMail (Zoho) HTTP API.
//
// Zeros already uses ZeptoMail for transactional auth email; the
// control plane reuses the same account via its REST API for invitation
// mail. Config:
//   ZEPTOMAIL_TOKEN  — "Send Mail Token" from the ZeptoMail Mail Agent
//   EMAIL_FROM       — verified sender, e.g. "Zeros <hello@zeros.build>"
// Unset → dev fallback: the message is logged, never sent, and the API
// still succeeds (the invite link is returned to the inviting admin, so
// manual sharing keeps working before credentials land).
// ──────────────────────────────────────────────────────────

// ZeptoMail Send Mail Tokens are bound to the data centre the account was
// created in, so the API host has to match that region or every send 401s.
// The default below is the region this deployment uses; override for another.
const ZEPTOMAIL_API =
  process.env.ZEPTOMAIL_API_URL?.trim() || "https://api.zeptomail.in/v1.1/email";

export type EmailConfig = {
  token: string | null;
  from: { address: string; name: string } | null;
};

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  // ZeptoMail's UI copies the Send Mail Token WITH the "Zoho-enczapikey "
  // scheme prefix; our request adds the scheme itself. Accept either paste
  // style — a doubled prefix comes back from their API as an empty 500.
  const token =
    env.ZEPTOMAIL_TOKEN?.trim().replace(/^Zoho-enczapikey\s+/i, "") || null;
  const raw = env.EMAIL_FROM?.trim() || null;
  if (!raw) return { token, from: null };
  // "Name <addr@domain>" or bare "addr@domain"
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  const from = match
    ? { name: match[1]?.trim() || "Zeros", address: match[2]!.trim() }
    : { name: "Zeros", address: raw };
  return { token, from };
}

export async function sendEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<void> {
  if (!config.token || !config.from) {
    console.log(
      `[email:dev-fallback] to=${to} subject=${JSON.stringify(subject)} (ZEPTOMAIL_TOKEN/EMAIL_FROM unset — not sent)`,
    );
    return;
  }
  const res = await fetch(ZEPTOMAIL_API, {
    method: "POST",
    headers: {
      authorization: `Zoho-enczapikey ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [{ email_address: { address: to } }],
      subject,
      htmlbody: htmlBody,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Deliberately NOT thrown to the caller as a request failure — the
    // invitation row exists and the admin got the copyable link; a mail
    // outage shouldn't roll that back. Logged for ops.
    console.error(`[email] zeptomail ${res.status}: ${detail.slice(0, 500)}`);
  }
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
