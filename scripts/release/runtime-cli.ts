import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PromotionError, requireCheck } from "./contracts";
import { runRuntimeController } from "./runtime-controller";
import { runRuntimeCleanup } from "./runtime-cleanup";

export async function runtimeMain(args = process.argv.slice(2), env = process.env) {
  requireCheck(args.length === 1 && ["--execute", "--cleanup"].includes(args[0]), "Usage: runtime-cli.ts --execute | --cleanup in the dispatched runtime release workflow");
  if (args[0] === "--cleanup") { await runRuntimeCleanup(env); console.log("Runtime release cleanup confirmed."); return; }
  const cancelled = new AbortController(), stop = () => cancelled.abort();
  const deadline = setTimeout(stop, 45 * 60_000); deadline.unref();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const receipt = await runRuntimeController(env, { signal: cancelled.signal });
    console.log(`Runtime release succeeded for ${receipt.channel} at ${receipt.runtime.sha256}.`);
  } finally {
    clearTimeout(deadline); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runtimeMain().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Runtime release failed; private diagnostics withheld");
  process.exitCode = 1;
});
