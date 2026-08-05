// ──────────────────────────────────────────────────────────
// Invite-email parsing — shared by the Members tab's invite composer and
// the Create-team dialog. One place decides what "a list of
// emails" means: split on commas/semicolons/whitespace/newlines, trim,
// lowercase, dedupe, validate, cap.
// ──────────────────────────────────────────────────────────

/** Matches the backend's invite-create rate limit (20 / 10 min / admin) so
 *  one batch can't half-succeed against the limiter. */
export const MAX_INVITES_PER_BATCH = 20;

// Same permissive shape the backend's Zod .email() accepts in practice —
// the server remains the real validator; this only catches typos early.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedInviteEmails = {
  /** Deduped, lowercased, valid addresses in input order. */
  valid: string[];
  /** Entries that don't look like an email (shown back to the user). */
  invalid: string[];
};

export function parseInviteEmails(raw: string): ParsedInviteEmails {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    if (!EMAIL_RE.test(entry) || entry.length > 254) {
      invalid.push(part.trim());
    } else if (!seen.has(entry)) {
      seen.add(entry);
      valid.push(entry);
    }
  }
  return { valid, invalid };
}
