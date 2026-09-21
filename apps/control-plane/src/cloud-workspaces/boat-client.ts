import { CloudProviderError } from "./provider.js";

export type BoatApiClientOptions = {
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
};
const MAX_RESPONSE_BYTES = 1024 * 1024;

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
        const retryable =
          response.status === 429 ||
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
              : response.status === 402
                ? "provider_budget_exhausted"
                : response.status === 429
                  ? "provider_rate_limited"
                  : "provider_request_failed";
        const retrySeconds = Number(response.headers.get("retry-after"));
        throw new CloudProviderError(
          code,
          "Boat API request did not succeed",
          retryable,
          {
            ...(Number.isFinite(retrySeconds) && retrySeconds > 0
              ? { retryAfterMs: Math.min(retrySeconds * 1000, 300_000) }
              : {}),
          },
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
