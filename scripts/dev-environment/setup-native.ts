import { fileURLToPath } from "node:url";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import { opSettingsRead, opSettingsWrite } from "../../apps/desktop/src/engine/settings/ops";

const legacyTools = 'if [ -d "$HOME/.zeros-dev/tools/bin" ]; then export PATH="$HOME/.zeros-dev/tools/bin:$PATH"; fi';
const setupCommand = `set -e
if [ -f scripts/dev-environment/hook.sh ]; then exec sh scripts/dev-environment/hook.sh setup; fi
${legacyTools}
pnpm install --frozen-lockfile
pnpm --dir apps/control-plane install --frozen-lockfile
npm --prefix apps/web ci`;
const runCommand = (action: "dev" | "backend") => `set -e
if [ -f scripts/dev-environment/hook.sh ]; then exec sh scripts/dev-environment/hook.sh ${action}; fi
${legacyTools}
exec pnpm electron:dev`;
const archiveCommand = fs.readFileSync(new URL("./archive-hook.sh", import.meta.url), "utf8").trim();

/** Use the app's settings lifecycle so comments, private ownership, Git
 * exclusions and linked-worktree inheritance follow the normal contracts. */
export function installNativeDevScripts(root: string) {
  const current = opSettingsRead("repo-local", root);
  if (current.error) throw new Error("Native Zeros settings could not be read; existing settings were preserved");
  const scripts = (current.doc?.scripts ?? {}) as Record<string, unknown>;
  if (typeof scripts.archive === "string" && scripts.archive.trim() && !["pnpm dev:archive", archiveCommand].includes(scripts.archive.trim())) {
    throw new Error("An existing native Zeros archive command was preserved. Configure an idempotent command that includes pnpm dev:archive in Repository Settings before enabling required cleanup.");
  }
  const patch: Record<string, unknown> = {
    archive: archiveCommand, archive_required: true, archive_timeout_seconds: 1800,
  };
  if (!scripts.setup) patch.setup = setupCommand;
  if (!scripts.run_mode) patch.run_mode = "concurrent";
  if (!scripts.run && !scripts.run_actions) {
    patch.run_actions = [
      { id: "zeros-dev", name: "Zeros Dev", command: runCommand("dev"), platforms: ["mac"], default: true, icon: "play" },
      { id: "zeros-dev-backend", name: "Dev Backend", command: runCommand("backend"), platforms: ["linux"], icon: "cloud" },
    ];
  }
  for (const key of Object.keys(patch)) {
    if (isDeepStrictEqual(patch[key], scripts[key])) delete patch[key];
  }
  if (Object.keys(patch).length) opSettingsWrite("repo-local", { scripts: patch }, root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    installNativeDevScripts(path.resolve(import.meta.dirname, "../.."));
    console.log("[zeros-dev] Native Zeros repository scripts configured; required Archive cleanup is enabled.");
  } catch (error) {
    console.error(`[zeros-dev] ${error instanceof Error ? error.message : "Native settings setup failed"}`);
    process.exitCode = 1;
  }
}
