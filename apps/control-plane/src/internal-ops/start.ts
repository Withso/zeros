import { serve } from "@hono/node-server";
import { z } from "zod";
import { providerChecks } from "./providers.js";
import { internalOpsServer, policySchema } from "./server.js";

// Separate process and deployment secrets from all customer-facing services.
try {
  const policy = policySchema.parse(
    JSON.parse(process.env.OPS_ACCESS_POLICY ?? ""),
  );
  const checks = providerChecks(process.env);
  if (policy.principals.some((p) => p.tools.some((tool) => !checks[tool])))
    throw new Error();
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.PORT ?? 8789);
  serve({
    fetch: internalOpsServer(policy, checks).fetch,
    hostname: process.env.OPS_LISTEN_HOST ?? "127.0.0.1",
    port,
  });
} catch {
  // Validation diagnostics can include rejected provider material.
  console.error(
    "Internal Ops MCP needs a valid access policy and configured provider targets",
  );
  process.exitCode = 1;
}
