import { z } from "zod";
import { DIGEST, PromotionError, requireCheck } from "./contracts";
import { runtimeOrigin } from "./runtime-contracts";

export async function requireCurrentAlphaRuntime(sha256: string, fetcher: typeof fetch = fetch): Promise<void> {
  requireCheck(DIGEST.test(sha256), "Alpha runtime digest is invalid");
  try {
    const response = await fetcher(`${runtimeOrigin("alpha")}/v1/release-identity`, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Alpha unavailable"); }
    const bytes = await response.text();
    requireCheck(bytes.length <= 32 * 1024, "Alpha identity is oversized");
    const identity = z.object({ version: z.literal(1), channel: z.literal("alpha"), ready: z.literal(true),
      worker: z.object({ sha256: z.literal(sha256) }) }).safeParse(JSON.parse(bytes));
    requireCheck(identity.success, "Alpha pin is unready or changed");
  } catch {
    throw new PromotionError("Promotion requires this digest to be Alpha's current ready runtime. Alpha is unavailable, unready or serving another pin; verify Alpha before retrying.");
  }
}
