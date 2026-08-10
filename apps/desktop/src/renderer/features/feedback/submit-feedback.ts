// ──────────────────────────────────────────────────────────
// Feedback submission → the authenticated control plane
// ──────────────────────────────────────────────────────────
//
// The Help → Feedback modal calls submitFeedback(); the Railway control plane
// turns it into an Intercom conversation and/or Linear issue.
//
// What we send is intentional — the user's own words to our support — plus a
// little safe metadata (type, app version). With the user's explicit opt-in
// ("Include recent app logs"), the secret-scrubbed recent log tail rides
// along too (viewable beforehand via the dialog's View button). NEVER keys
// or unscrubbed credentials.
//
// We do NOT send an address. The control plane takes the sender's identity from
// its verified Auth0 session, so the address Intercom shows is one Auth0
// verified. The modal used to have an "Email (optional)" field and trusted it,
// which meant anyone holding the old bundled shared secret could impersonate
// an address.
// ──────────────────────────────────────────────────────────

import { isElectron, nativeInvoke } from "@/renderer/platform/runtime";
import {
  analyticsDistinctId,
  capture,
} from "@/renderer/platform/observability/analytics/posthog";
import { getSession } from "@/renderer/features/auth/auth-store";
import { CONTROL_PLANE_URL } from "@/renderer/features/team/control-plane";
import type { FeedbackType } from "./feedback-types";

export type { FeedbackType } from "./feedback-types";

export interface FeedbackInput {
  type: FeedbackType;
  message: string;
  /** Coarse surface the user was on (e.g. "chat"). Metadata only. */
  area?: string;
  /** Opt-in recent app logs (JSONL tail, secret-scrubbed by the main process
   *  — see apps/desktop/electron/ipc/commands/logs.ts). Only set when the user checked
   *  "Include recent app logs" in the dialog. */
  logs?: string;
}

/** Client-side ceiling on the log payload — matches the backend's MAX_LOGS so
 *  the request body stays comfortably under control-plane/Intercom limits. The main
 *  process already applies this same cap to logs_recent AND the "View" export
 *  (apps/desktop/electron/ipc/commands/logs.ts MAX_EXPORT_CHARS), so View is byte-identical
 *  to what we submit; this slice is a defensive backstop only. */
const MAX_LOGS_CHARS = 500_000;

/** Fetch the scrubbed recent-log tail from the main process. Returns
 *  undefined outside Electron or when the store is empty/unavailable. */
export async function recentLogsForFeedback(): Promise<string | undefined> {
  if (!isElectron()) return undefined;
  try {
    const res = await nativeInvoke<{ text?: string }>("logs_recent");
    const text = res?.text ?? "";
    if (!text) return undefined;
    // Keep the TAIL when over the cap — newest records matter most.
    return text.length > MAX_LOGS_CHARS ? text.slice(-MAX_LOGS_CHARS) : text;
  } catch {
    return undefined;
  }
}

const FEEDBACK_URL = CONTROL_PLANE_URL
  ? `${CONTROL_PLANE_URL}/v1/feedback`
  : null;

/** Whether feedback submission is wired in this build. The Help menu hides
 *  "Send feedback" when this is false.
 *
 *  Feedback now follows the same environment-specific control-plane URL as
 *  organizations. Auth rides on the user's own session, so there is no second
 *  endpoint or build-time credential to drift across Alpha/Beta/Production. */
export function isFeedbackConfigured(): boolean {
  return !!FEEDBACK_URL;
}

async function appVersion(): Promise<string | undefined> {
  if (!isElectron()) return undefined;
  try {
    const info = await nativeInvoke<{ version?: string }>("app_info");
    return info?.version;
  } catch {
    return undefined;
  }
}

/** Submit feedback to the control plane. Resolves on success; throws a user-facing
 *  Error on failure (the caller toasts it). */
export async function submitFeedback(input: FeedbackInput): Promise<void> {
  if (!FEEDBACK_URL) {
    throw new Error("Feedback isn't set up in this build yet.");
  }
  const message = input.message.trim();
  if (!message) throw new Error("Please write a message first.");

  const session = await getSession();
  const accessToken = session?.access_token;
  if (!accessToken) {
    throw new Error("Please sign in to send feedback.");
  }

  const res = await fetch(FEEDBACK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      type: input.type,
      message,
      area: input.area,
      app_version: await appVersion(),
      logs: input.logs || undefined,
      // Anonymous PostHog id so the report can be cross-referenced with the
      // sender's events / error-tracking issues (those sync to the tracker).
      posthog_distinct_id: analyticsDistinctId(),
    }),
  });
  if (res.status === 401) {
    // The session lapsed between opening the modal and sending. Say so plainly
    // rather than "couldn't send (401)" — the fix is a sign-in, not a retry.
    throw new Error("Your session expired. Sign in again to send feedback.");
  }
  if (!res.ok) {
    throw new Error(
      `Couldn't send feedback (${res.status}). Please try again.`,
    );
  }
  // Product signal only — type + whether logs rode along. NEVER the message
  // or the logs themselves (PostHog is metadata-only by contract).
  capture("feedback_submitted", {
    feedback_type: input.type,
    included_logs: Boolean(input.logs),
  });
}
