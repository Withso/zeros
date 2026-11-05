import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PromotionError, requireCheck } from "./contracts";
import { runtimeBuildConfig } from "./runtime-contracts";
import { buildRuntime } from "./runtime-build";
import { writeRuntimeJson } from "./runtime-artifacts";

export async function runtimeBuildMain(env: NodeJS.ProcessEnv = process.env) {
  requireCheck(process.argv.length === 2, "Runtime build takes its immutable inputs from the workflow environment");
  const metadata = await buildRuntime(runtimeBuildConfig(env), env, {
    candidate: ".context/runtime-candidate", archive: ".context/runtime-build/runtime.tar.gz",
  });
  await writeRuntimeJson(".context/runtime-build/runtime-build.json", metadata);
  console.log("Runtime archive built from the exact source; publication remains pending.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runtimeBuildMain().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Runtime build failed; private diagnostics withheld");
  process.exitCode = 1;
});
