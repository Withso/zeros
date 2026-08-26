import { Hono } from "hono";

import {
  WorkOSDesktopVerificationError,
  type WorkOSDesktopVerificationProvider,
} from "./workos-provider.js";

export { WorkOSDesktopVerificationError } from "./workos-provider.js";

const MAX_REQUEST_BYTES = 12 * 1_024;
const EMAIL_VERIFICATION_ID = /^email_verification_[A-Za-z0-9_-]{1,480}$/;

async function boundedJson(request: Request): Promise<unknown | null> {
  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    return null;
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function challenge(body: unknown): {
  pendingAuthenticationToken: string;
  emailVerificationId: string;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const pendingAuthenticationToken = raw.pending_authentication_token;
  const emailVerificationId = raw.email_verification_id;
  if (
    typeof pendingAuthenticationToken !== "string" ||
    pendingAuthenticationToken.length === 0 ||
    pendingAuthenticationToken.length > 8_192 ||
    typeof emailVerificationId !== "string" ||
    !EMAIL_VERIFICATION_ID.test(emailVerificationId)
  ) {
    return null;
  }
  return { pendingAuthenticationToken, emailVerificationId };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

export function createWorkOSDesktopVerificationRoutes(
  provider: WorkOSDesktopVerificationProvider,
): Hono {
  const app = new Hono();
  app.post("/auth/desktop/complete-github-verification", async (c) => {
    const input = challenge(await boundedJson(c.req.raw));
    if (!input) return json({ error: "bad_request" }, 400);
    try {
      const result = await provider.completeGitHubVerification(input);
      return json({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        authentication_method: result.authenticationMethod,
        user: {
          id: result.user.id,
          email: result.user.email,
          email_verified: result.user.emailVerified,
          name: result.user.name,
        },
      });
    } catch (error) {
      if (error instanceof WorkOSDesktopVerificationError) {
        console.warn(
          `[workos-desktop-verification] 403 verification rejected: ${error.code}`,
        );
        return json({ error: "verification_rejected" }, 403);
      }
      console.warn(
        "[workos-desktop-verification] 503 WorkOS continuation unavailable",
      );
      return json({ error: "verification_unavailable" }, 503);
    }
  });
  return app;
}
