import { IS_DEV } from "./runtime-mode";

declare const __ZEROS_CONTROL_PLANE_URL_BAKED__: string | undefined;

const PRODUCTION_CONTROL_PLANE = "https://api.zeros.build";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ERROR_CODE_LENGTH = 128;
const RECOVERY_CODE_RE = /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/** A refusal from `/v1/me` that keeps the control plane's own error code.
 *
 *  The control plane deliberately distinguishes actionable states —
 *  `email_unverified`, `account_exists`, `signup_throttled`, `account_deleted` —
 *  and each one needs a different action from the user. Replacing all of them
 *  with one message stripped exactly the information the sign-in screen needs. */
export class WorkOSDesktopAccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly recoveryCode: string | null = null,
  ) {
    super(
      code
        ? `The Zeros account could not be resolved [${code}]`
        : "The Zeros account could not be resolved",
    );
    this.name = "WorkOSDesktopAccountError";
  }
}

async function boundedResponseText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("response too large").catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Read a deliberately tiny subset of `{error:{code,details}}` without
 * trusting response length, shape, content type, provider wording, or HTML. */
async function controlPlaneError(
  response: Response,
): Promise<{ code: string | null; recoveryCode: string | null }> {
  try {
    const text = await boundedResponseText(response);
    if (!text) return { code: null, recoveryCode: null };
    const body: unknown = JSON.parse(text);
    const error =
      body && typeof body === "object" && "error" in body
        ? (body as { error: unknown }).error
        : null;
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code: unknown }).code
        : null;
    const safeCode = typeof code === "string" &&
      code.length > 0 &&
      code.length <= MAX_ERROR_CODE_LENGTH
      ? code
      : null;
    const details =
      error && typeof error === "object" && "details" in error
        ? (error as { details: unknown }).details
        : null;
    const recoveryCode =
      safeCode === "account_recovery_required" &&
      details &&
      typeof details === "object" &&
      "recoveryCode" in details &&
      typeof (details as { recoveryCode: unknown }).recoveryCode === "string" &&
      RECOVERY_CODE_RE.test(
        (details as { recoveryCode: string }).recoveryCode,
      )
        ? (details as { recoveryCode: string }).recoveryCode
        : null;
    return { code: safeCode, recoveryCode };
  } catch {
    return { code: null, recoveryCode: null };
  }
}

export function controlPlaneBaseUrl(): string {
  const baked =
    typeof __ZEROS_CONTROL_PLANE_URL_BAKED__ === "string"
      ? __ZEROS_CONTROL_PLANE_URL_BAKED__
      : "";
  const raw =
    process.env.ZEROS_CONTROL_PLANE_URL?.trim() ||
    process.env.VITE_CONTROL_PLANE_URL?.trim() ||
    baked.trim() ||
    PRODUCTION_CONTROL_PLANE;
  const url = new URL(raw);
  const loopback =
    IS_DEV &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The control-plane URL is invalid");
  }
  return url.origin;
}

export async function resolveWorkOSDesktopAccountId(
  accessToken: string,
): Promise<string> {
  const response = await fetch(`${controlPlaneBaseUrl()}/v1/me`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = await controlPlaneError(response);
    throw new WorkOSDesktopAccountError(
      response.status,
      error.code,
      error.recoveryCode,
    );
  }
  const text = await boundedResponseText(response);
  if (!text) {
    throw new Error("The Zeros account response was invalid");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("The Zeros account response was invalid");
  }
  const accountId =
    body &&
    typeof body === "object" &&
    "user" in body &&
    body.user &&
    typeof body.user === "object" &&
    "id" in body.user &&
    typeof body.user.id === "string"
      ? body.user.id
      : "";
  if (!UUID_RE.test(accountId)) {
    throw new Error("The Zeros account response omitted its identifier");
  }
  return accountId;
}
