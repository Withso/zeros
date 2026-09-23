import { CloudProviderError } from "./provider.js";
import type { CloudProviderCreateRejectionCode } from "./provider-operation-store.js";

export type BoatApiClientOptions = {
  apiKey: string;
  timeoutMs: number;
  /** Boat organization wallet billed for new sandboxes. Without it Boat uses
   * the account's mutable, dashboard-selected wallet. */
  billingOrg?: string;
  fetch?: typeof fetch;
};
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Boat reports an organization-billed sandbox's wallet as its `team`. */
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

function qualifiedLimitDetails(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: details, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 2048 || depth > 8) return false;
    if (value && typeof value === "object") {
      if (!Array.isArray(value) && Object.keys(value).some(key => !REJECTION_LIMIT_FIELDS.has(key))) return false;
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
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

function createRejection(value: Record<string, unknown> | null): CloudProviderCreateRejectionCode | null {
  const nested = value?.error;
  if (value?.ok !== false || value.type !== "sandbox.error" || value.status !== 429 ||
      Object.keys(value).some(key => !REJECTION_FIELDS.has(key)) ||
      ("message" in value && typeof value.message !== "string") ||
      typeof value.requestId !== "string" || !/^req_[a-zA-Z0-9_-]{1,124}$/.test(value.requestId) ||
      !nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const error = nested as Record<string, unknown>;
  if (error.status !== 429 || error.code !== value.code ||
      Object.keys(error).some(key => !REJECTION_ERROR_FIELDS.has(key)) ||
      ("message" in error && typeof error.message !== "string") ||
      ("details" in error && !qualifiedLimitDetails(error.details))) return null;
  // Concurrent-allocation refusals are documented by the create endpoint.
  // The trial cap's exact error envelope is additionally live-qualified; a
  // generic 429, budget error, malformed envelope or later retry is not proof.
  switch (value.code) {
    case "limit_reached":
    case "member_limit_reached":
    case "trial_compute_limit_reached": return value.code;
    default: return null;
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
        const rejected = path === "/sandboxes" && input.method === "POST" && input.idempotencyKey && response.status === 429
          ? createRejection(value) : null;
        if (rejected) throw new BoatCreateRejectedError(code, retryable, rejected, retryOptions);
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
