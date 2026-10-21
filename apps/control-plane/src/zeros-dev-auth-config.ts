import { z } from "zod";
import type { AuthBackendConfig } from "./config.js";
import { cloudWorkspaceChannelEnabled } from "./cloud/channel-policy.js";

export type ZerosDevAuthConfig = {
  subject: string;
  accountId: string;
  email: string;
  organizationId: string;
};

const Identity = z.object({
  subject: z.string().regex(/^user_[A-Za-z0-9_-]{1,240}$/),
  accountId: z.string().uuid(),
  email: z.string().email().max(254).refine(value => value === value.trim().toLowerCase()),
  organizationId: z.string().uuid(),
}).strict();

/** A checked-in pause or any non-Alpha deployment wins over stale opt-ins.
 * Never import this boundary into a VM: channel-less engines remain unchanged. */
export function loadZerosDevAuthConfig(
  env: NodeJS.ProcessEnv,
  channel: string,
  auth: AuthBackendConfig,
): ZerosDevAuthConfig | null {
  if (channel !== "alpha" || !cloudWorkspaceChannelEnabled(channel)) return null;
  if (!env.ZEROS_DEV_AUTH_ENABLED || env.ZEROS_DEV_AUTH_ENABLED === "false") return null;
  const parsed = Identity.safeParse({ subject: env.ZEROS_DEV_AUTH_SUBJECT,
    accountId: env.ZEROS_DEV_AUTH_ACCOUNT_ID, email: env.ZEROS_DEV_AUTH_EMAIL,
    organizationId: env.ZEROS_DEV_AUTH_ORGANIZATION_ID });
  if (env.ZEROS_DEV_AUTH_ENABLED !== "true" || !parsed.success || auth.provider !== "workos" ||
      auth.audience !== "https://api-alpha.zeros.build" ||
      auth.issuer !== `https://api.workos.com/user_management/${auth.webClientId}` ||
      auth.jwksUrl !== `https://api.workos.com/sso/jwks/${auth.webClientId}`) {
    // Do not include zod issues or operator values in a boot diagnostic.
    throw new Error("Invalid zeros-dev authentication configuration");
  }
  return parsed.data;
}

export class ZerosDevAuthError extends Error {
  constructor(readonly kind: "denied" | "unavailable" | "rate_limited") {
    super(`zeros_dev_auth_${kind}`);
  }
}
