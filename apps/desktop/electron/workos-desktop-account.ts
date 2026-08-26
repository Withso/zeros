import { IS_DEV } from "./runtime-mode";

declare const __ZEROS_CONTROL_PLANE_URL_BAKED__: string | undefined;

const PRODUCTION_CONTROL_PLANE = "https://api.zeros.build";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ERROR_CODE_LENGTH = 128;

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
  ) {
    super(
      code
        ? `The Zeros account could not be resolved [${code}]`
        : "The Zeros account could not be resolved",
    );
    this.name = "WorkOSDesktopAccountError";
  }
}

/** Read `{error:{code}}` without trusting length, shape, or content type. */
async function controlPlaneErrorCode(
  response: Response,
): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text || text.length > MAX_RESPONSE_BYTES) return null;
    const body: unknown = JSON.parse(text);
    const error =
      body && typeof body === "object" && "error" in body
        ? (body as { error: unknown }).error
        : null;
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code: unknown }).code
        : null;
    return typeof code === "string" &&
      code.length > 0 &&
      code.length <= MAX_ERROR_CODE_LENGTH
      ? code
      : null;
  } catch {
    return null;
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
    throw new WorkOSDesktopAccountError(
      response.status,
      await controlPlaneErrorCode(response),
    );
  }
  const text = await response.text();
  if (!text || text.length > MAX_RESPONSE_BYTES) {
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
