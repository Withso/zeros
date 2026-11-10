import { isIP } from "node:net";
import type { Context } from "hono";
import { HttpError } from "../../authz.js";
import { rateLimit } from "../../ratelimit.js";
import type { CloudApiCredentials } from "./credentials.js";

/** Use the trusted Railway address, matching feedback's pre-auth boundary. */
const address = (context: Context) => {
  const address = context.req.header("X-Real-IP")?.trim() ?? "";
  return isIP(address) ? address : "unknown";
};
const failedLookup = rateLimit("cloud-api-preauth", 1200, 60_000, address);
export const cloudApiPreAuthLimit = () => rateLimit("cloud-api-preauth", 1200, 60_000, address, { checkOnly: true });

export async function resolveCloudApiCredential(context: Context, credentials: Pick<CloudApiCredentials, "resolve">) {
  try { return await credentials.resolve(context.req.header("authorization")); }
  catch (error) {
    // A shared VM egress address spends this budget only on failed credentials.
    if (error instanceof HttpError && error.status === 401) await failedLookup(context, async () => {});
    throw error;
  }
}
