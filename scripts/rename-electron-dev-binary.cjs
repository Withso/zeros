// ──────────────────────────────────────────────────────────
// Patch the shared dev Electron.app to identify as "Zeros Dev"
// ──────────────────────────────────────────────────────────
//
// Standalone entry for `pnpm electron:rename-dev`. The actual macOS bundle
// patching now lives in scripts/dev-electron-bundle.cjs and is shared with the
// per-worktree instance launcher (scripts/dev-instance.mjs), which is what
// `pnpm electron:dev` runs. This wrapper preserves the original behavior — patch
// the shared node_modules Electron.app in place → "Zeros Dev" —  for anyone who
// invokes it directly. Idempotent; no effect on packaged builds or off-macOS.
// ──────────────────────────────────────────────────────────

const { prepareSharedDevBundle } = require("./dev-electron-bundle.cjs");

if (process.platform === "darwin") {
  prepareSharedDevBundle();
}
