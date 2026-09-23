import { CloudProviderError } from "./provider.js";
import type { CloudProviderCreateRejectionCode } from "./provider-operation-store.js";

export type BoatApiClientOptions = {
  apiKey: string;
  timeoutMs: number;
  /** Boat organization wallet billed for new sandboxes. Without it Boat uses
   * the account's mutable, dashboard-selected wallet. */
  billingOrg?: string;
  fetch?: typeof fetch;
  /** Receives bounded, value-free explanations of uncertified create
   * refusals. Defaults to console.warn; delivery failures are ignored. */
  diagnostics?: (line: string) => void;
};
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Boat reports an organization-billed sandbox's wallet as its `team`. */
/** Boat sandbox identifiers use a fixed-length unambiguous alphabet. */
export const BOAT_RESOURCE_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
export const BOAT_BILLING_ORG_PATTERN =
  /^team_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REJECTION_FIELDS = new Set(["ok", "type", "status", "code", "message", "error", "requestId"]);
const REJECTION_ERROR_FIELDS = new Set(["code", "message", "status", "details"]);
// This is the account-limit document observed with the qualified trial and
// member concurrent-cap refusals. Unknown diagnostic fields leave the dispatch
// uncertain, rather than allowing a newly introduced allocation/operation
// receipt to masquerade as a refusal.
const REJECTION_LIMIT_FIELDS = new Set([
  "accessTier", "accountPlan", "activeSandboxes", "activeStates", "billingStatus", "billingUrl",
  "blockedReason", "canCreate", "canStart", "checkoutRequired", "contactMessage",
  "creationRatePerMinute", "creationRequestsPerDay", "creationRequestsPerHour",
  "creditBalanceHours", "creditBalanceSeconds", "creditPurchasedSeconds", "creditSecondsPerDollar",
  "creditUsedSeconds", "currentLimits", "displayPrice", "dollars", "endTrialOrFirstPayment",
  "error", "giftLimit", "hasPaymentHistory", "hasSeatPlan", "hasSubscription", "includedSeconds",
  "key", "last24hUsageSeconds", "liveUsageSeconds", "maxActiveSandboxes", "maxCreationRequestsPerDay",
  "maxCreationRequestsPerMinute", "memberMaxActiveSandboxes", "message", "note", "pack",
  "packBalanceDollars", "packBalanceHours",
  "packBalanceSeconds", "package", "perDay", "perHour", "perMinute", "persistsAcrossMonths",
  "plan", "planName", "purchasable", "sandboxPlanDollars", "sandboxPlanKey", "sandboxPlanTiers",
  "seconds", "secondsPerDollar", "serviceAccount", "standardLimits", "startBlockedReason",
  "startLimits", "startTrial", "startsPerDay", "startsPerHour", "startsPerMinute", "status",
  "subscriptionCancelAtPeriodEnd", "subscriptionCurrentPeriodEnd", "subscriptionQuotaSeconds",
  "subscriptionRemainingSeconds", "subscriptionStatus", "subscriptionTrialEndsAt",
  "trialComputeCapSeconds", "trialLimits", "trialLine", "unlimited", "upgradeEffects",
]);

// A refusal never names an allocation or a deletion operation.
const PROVIDER_IDENTIFIER = /(?<![A-Za-z0-9])(?:bx|bdop)_[A-Za-z0-9]/;
// Concurrent-allocation refusals are documented by the create endpoint. The
// trial cap's exact error envelope is additionally live-qualified; a generic
// 429, budget error, malformed envelope or later retry is not proof.
const CERTIFIED_CREATE_REJECTIONS = new Set<string>(["limit_reached", "member_limit_reached", "trial_compute_limit_reached"]);
// Documented refusal codes that are safe to name in operator diagnostics.
const NAMEABLE_REFUSAL_CODES = new Set<string>([...CERTIFIED_CREATE_REJECTIONS, "rate_limited", "daily_limit_reached"]);
// Diagnostics name only plain camelCase field names; anything that could carry
// an identifier or token is redacted.
const NAMEABLE_FIELD = /^[a-z][A-Za-z]{0,39}$/;
const MAX_SHOWN_REASONS = 8, MAX_COLLECTED_REASONS = 32;

type RefusalReason = { rank: number; text: string };
type CreateRefusalAssessment = { code: CloudProviderCreateRejectionCode | null; reasons: RefusalReason[] };

/** The single certification rule for a create 429: every structural check
 * that failed is a reason, and only a refusal without reasons is certified.
 * Reasons carry shapes and plain field names, never values. */
function assessCreateRefusal(value: Record<string, unknown> | null): CreateRefusalAssessment {
  const reasons = new Map<string, number>();
  const add = (rank: number, text: string) => { if (reasons.size < MAX_COLLECTED_REASONS && !reasons.has(text)) reasons.set(text, rank); };
  const field = (key: string) => NAMEABLE_FIELD.test(key) && !PROVIDER_IDENTIFIER.test(key) ? key : "<redacted>";
  const message = (candidate: unknown) => {
    if (candidate === undefined) return;
    if (typeof candidate !== "string") add(0, "message_shape");
    else if (PROVIDER_IDENTIFIER.test(candidate)) add(1, "identifier_in_message");
  };
  if (!value) add(0, "envelope_not_json");
  else {
    if (value.ok !== false || value.type !== "sandbox.error" || value.status !== 429) add(0, "envelope_shape");
    for (const key of Object.keys(value)) if (!REJECTION_FIELDS.has(key)) add(1, `unknown_envelope_key:${field(key)}`);
    if (typeof value.requestId !== "string" || !/^req_[a-zA-Z0-9_-]{1,124}$/.test(value.requestId)) add(0, "request_id_shape");
    if (typeof value.code !== "string" || !CERTIFIED_CREATE_REJECTIONS.has(value.code)) add(0, "unrecognized_code");
    message(value.message);
    const nested = value.error;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) add(0, "error_shape");
    else {
      const error = nested as Record<string, unknown>;
      if (error.status !== 429 || error.code !== value.code) add(0, "error_code_or_status");
      for (const key of Object.keys(error)) if (!REJECTION_ERROR_FIELDS.has(key)) add(1, `unknown_error_key:${field(key)}`);
      message(error.message);
      if ("details" in error) {
        if (!error.details || typeof error.details !== "object" || Array.isArray(error.details)) add(0, "details_shape");
        else {
          const pending: Array<{ value: unknown; depth: number }> = [{ value: error.details, depth: 0 }];
          for (let nodes = 0; pending.length;) {
            const next = pending.pop()!;
            if (++nodes > 2048 || next.depth > 8) { add(0, "details_too_large"); break; }
            if (typeof next.value === "string" && PROVIDER_IDENTIFIER.test(next.value)) add(1, "identifier_in_details");
            if (next.value && typeof next.value === "object") {
              if (!Array.isArray(next.value))
                for (const key of Object.keys(next.value)) if (!REJECTION_LIMIT_FIELDS.has(key)) add(2, `unknown_detail_key:${field(key)}`);
              for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
            }
          }
        }
      }
    }
  }
  const ordered = [...reasons].map(([text, rank]) => ({ rank, text }))
    .sort((a, b) => a.rank - b.rank || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return ordered.length === 0
    ? { code: value!.code as CloudProviderCreateRejectionCode, reasons: [] }
    : { code: null, reasons: ordered };
}

/** Only qualified admission rejections, never arbitrary vendor error text. */
export class BoatCreateRejectedError extends CloudProviderError {
  constructor(
    code: string, retryable: boolean,
    readonly createRejectionCode: CloudProviderCreateRejectionCode,
    options: { retryAfterMs?: number },
  ) {
    super(code, "Boat API request did not succeed", retryable, options);
  }
}

/** Credentials are sent only to the provider's pinned API origin. Redirects,
 * response bodies and vendor error text never enter coordinator diagnostics. */
export class BoatApiClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: BoatApiClientOptions) {
    if (
      typeof options.apiKey !== "string" ||
      !/^[\x21-\x7e]{16,4096}$/.test(options.apiKey)
    )
      throw new Error("Invalid Boat credential");
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 610_000
    )
      throw new Error("Invalid Boat request deadline");
    if (options.billingOrg !== undefined && !BOAT_BILLING_ORG_PATTERN.test(options.billingOrg))
      throw new Error("Invalid Boat billing organization");
    this.fetcher = options.fetch ?? fetch;
  }

  private readonly reported = new Map<string, number>();

  /** At most one report per distinct explanation per ten minutes. Reporting
   * never changes how the refusal itself is classified. */
  private reportUncertifiedRefusal(value: Record<string, unknown> | null, reasons: RefusalReason[]): void {
    try {
      const refusal = typeof value?.code === "string" && NAMEABLE_REFUSAL_CODES.has(value.code) ? value.code : "other";
      const shown = reasons.slice(0, MAX_SHOWN_REASONS).map(reason => reason.text);
      const hidden = reasons.length - shown.length;
      const line = `[boat] create refusal not certified (${refusal}): ${shown.join(",")}${hidden > 0 ? `,+${hidden} more` : ""}`;
      const now = Date.now(), last = this.reported.get(line);
      if (last !== undefined && now - last < 10 * 60_000) return;
      if (this.reported.size >= 64) this.reported.delete(this.reported.keys().next().value!);
      this.reported.delete(line); this.reported.set(line, now);
      (this.options.diagnostics ?? (message => console.warn(message)))(line);
    } catch { /* diagnostics are best effort */ }
  }

  async request(
    path: string,
    input: {
      method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
      body?: unknown;
      idempotencyKey?: string;
      confirmDelete?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (
      !/^\/[a-zA-Z0-9/_-]+(?:\?[a-zA-Z0-9_=&%.-]+)?$/.test(path) ||
      path.startsWith("//") ||
      path.includes("..")
    )
      throw new Error("Invalid Boat API path");
    const headers = new Headers({
      authorization: `Bearer ${this.options.apiKey}`,
      accept: "application/json",
    });
    if (input.body !== undefined)
      headers.set("content-type", "application/json");
    if (input.idempotencyKey)
      headers.set("idempotency-key", input.idempotencyKey);
    if (input.confirmDelete)
      headers.set("x-ascii-confirm-delete", input.confirmDelete);
    // A sandbox keeps the wallet chosen at creation. Boat matches idempotent
    // creates on account, key and body, so the scope never changes a replay.
    if (this.options.billingOrg && path === "/sandboxes" && input.method === "POST")
      headers.set("x-boat-org", this.options.billingOrg);
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs),
      ...(input.signal ? [input.signal] : []),
    ]);
    try {
      const response = await this.fetcher(`https://boat.dev/api/v1${path}`, {
        method: input.method ?? "GET",
        headers,
        redirect: "error",
        signal,
        ...(input.body !== undefined
          ? { body: JSON.stringify(input.body) }
          : {}),
      });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      try {
        if (reader)
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES)
              throw new CloudProviderError(
                "provider_response_too_large",
                "Boat response exceeded its size limit",
                false,
              );
            chunks.push(next.value);
          }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      const value =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : null;
      if (!response.ok || value?.ok === false) {
        // Boat may report the nonrenewable trial compute allowance as HTTP
        // 429 even while /limits says canStart. Waiting cannot replenish it.
        const trialBudgetExhausted = response.status === 429 &&
          value?.code === "trial_compute_limit_reached";
        const retryable =
          (response.status === 429 && !trialBudgetExhausted) ||
          response.status === 408 ||
          response.status >= 500 ||
          (response.status === 409 &&
            ["idempotency_in_progress", "boat_restoring"].includes(
              String(value?.code),
            ));
        const code =
          response.status === 404
            ? "provider_not_found"
            : response.status === 401 || response.status === 403
              ? "provider_credential_rejected"
              : response.status === 402 || trialBudgetExhausted
                ? "provider_budget_exhausted"
                : response.status === 429
                  ? "provider_rate_limited"
                  : "provider_request_failed";
        const retrySeconds = Number(response.headers.get("retry-after"));
        const retryOptions = Number.isFinite(retrySeconds) && retrySeconds > 0
          ? { retryAfterMs: Math.min(retrySeconds * 1000, 300_000) } : {};
        const createRefusal = path === "/sandboxes" && input.method === "POST" && Boolean(input.idempotencyKey) && response.status === 429;
        const assessment = createRefusal ? assessCreateRefusal(value) : null;
        if (assessment?.code) throw new BoatCreateRejectedError(code, retryable, assessment.code, retryOptions);
        if (assessment) this.reportUncertifiedRefusal(value, assessment.reasons);
        throw new CloudProviderError(
          code,
          "Boat API request did not succeed",
          retryable,
          retryOptions,
        );
      }
      if (!value || value.ok !== true)
        throw new CloudProviderError(
          "provider_response_invalid",
          "Boat returned an invalid response",
          false,
        );
      return value;
    } catch (error) {
      if (error instanceof CloudProviderError) throw error;
      throw new CloudProviderError(
        signal.aborted
          ? "provider_request_timeout"
          : "provider_request_unavailable",
        "Boat request could not be confirmed",
        true,
      );
    }
  }
}
