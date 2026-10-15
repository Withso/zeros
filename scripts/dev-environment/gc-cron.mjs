#!/usr/bin/env node
import { runHostedGcCli, assertScheduledGcRuntime } from "./gc-cli.mjs";
import { devEnvironmentDiagnostic } from "./dependency-preflight.mjs";
// Railway launches one run per schedule. It exits after closing all clients.
// A mounted 0600 profile belongs to a separate Dev operations principal.
try {
  assertScheduledGcRuntime(process.env);
  const ok = await runHostedGcCli(["--all", "--json", ...(process.env.ZEROS_DEV_GC_APPLY === "1" ? ["--apply"] : [])]);
  if (!ok) process.exitCode = 1;
} catch (error) { console.error(JSON.stringify(devEnvironmentDiagnostic(error))); process.exitCode = 1; }
