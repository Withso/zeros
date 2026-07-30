// Vitest config for the engine + pure-function modules. Coverage has grown well
// beyond the original git-only scope: see the `include` globs below (engine
// git/agents/transport/pty/files/auth/db/settings/workspace, several
// src/zeros/* pure-helper suites, src/shell, electron/ipc command handlers, and
// packages/core crypto).
//
// The renderer's full React tree and Electron-only runtime modules stay out of
// scope. Plain TS helpers, node-env handlers, and small server-renderable
// primitive contracts are testable here.

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: [
      // Release version scheme (pure function: baseline + tags → version).
      "scripts/__tests__/**/*.test.ts",
      "src/engine/git/__tests__/**/*.test.ts",
      "src/engine/agents/**/__tests__/**/*.test.ts",
      "src/zeros/store/__tests__/**/*.test.ts",
      // Native renderer boundary parsers (pure validation, no Electron host).
      "src/native/__tests__/**/*.test.ts",
      // Pure-function @-mention helpers (fuzzy file/folder ranking).
      "src/zeros/agent/__tests__/**/*.test.ts",
      // Files-tab release: read_file IPC handler + column-3 tab manager.
      "electron/ipc/commands/__tests__/**/*.test.ts",
      // App log store: repeat coalescing (storm dedup) in electron/log-store.ts.
      "electron/__tests__/**/*.test.ts",
      "src/shell/__tests__/**/*.test.ts",
      // Terminal panel: shared-terminal (multiplayer) store merge.
      "src/shell/terminal/__tests__/**/*.test.ts",
      // Files-tab editor (Phase 2): CodeMirror language resolver (pure, lazy).
      "src/shell/column3-tabs/**/__tests__/**/*.test.ts",
      // PR feature: instruction brief, island state machine, compare-URL, prompts.
      "src/shell/pr/__tests__/**/*.test.ts",
      // Appearance: unified code-theme registry + diff-theme resolution.
      "src/zeros/appearance/__tests__/**/*.test.ts",
      // Analytics: renderer emit-site PII contract (metadata-only guarantee).
      "src/zeros/analytics/__tests__/**/*.test.ts",
      // Shared crypto primitives + EncryptedChannel (kept for the future cloud transport).
      "packages/core/src/**/__tests__/**/*.test.ts",
      // Engine transport: local + cloud transport end-to-end.
      "src/engine/transport/__tests__/**/*.test.ts",
      // Bridge protocol: PTY + workspace request/response round-trips over the socket.
      "src/zeros/bridge/__tests__/**/*.test.ts",
      // Auth: pure error-mapping (enumeration-neutrality guard).
      "src/zeros/auth/__tests__/**/*.test.ts",
      // Remote Workspace API: service dispatch + write-approval broker.
      "src/engine/workspace/__tests__/**/*.test.ts",
      // Terminal: engine PTY service (injected spawn, no native binding).
      "src/engine/pty/__tests__/**/*.test.ts",
      // Run tab: RunManager status engine (fake PTY, hand-driven exits).
      "src/engine/run/__tests__/**/*.test.ts",
      // Files: bounded read + remote-boundary sensitive-file denylist.
      "src/engine/files/__tests__/**/*.test.ts",
      // Account-binding: JWT verification (HS256/ES256/RS256).
      "src/engine/auth/__tests__/**/*.test.ts",
      // Universal storage: the unified engine-owned Zeros DB (schema + migrations).
      "src/engine/db/__tests__/**/*.test.ts",
      // Engine runtime mode + loopback port range (dev/prod isolation).
      "src/engine/__tests__/**/*.test.ts",
      // Spawn env: undoing the `npm/pnpm run` that launched the app.
      "src/engine/env/__tests__/**/*.test.ts",
      // Settings foundation: TOML layers, per-leaf sanitize, provenance resolve.
      "src/engine/settings/__tests__/**/*.test.ts",
      // Settings → MCP panel: pure data helpers (raw round-trip, validation).
      "src/zeros/panels/__tests__/**/*.test.ts",
      // Small renderer primitives whose static markup carries accessibility
      // contracts (for example, visible keyboard-focus forwarding).
      "src/zeros/ui/primitives/__tests__/**/*.test.ts",
      // Renderer settings stores: internal-features allowlist + flag gate.
      "src/zeros/settings/__tests__/**/*.test.ts",
      // Shared renderer lib helpers (e.g. Dashboard card-action state machine).
      "src/zeros/lib/__tests__/**/*.test.ts",
      // Teams: invite-link parsing (host pinning, token shape).
      "src/zeros/team/__tests__/**/*.test.ts",
      // Structured logging: renderer console-arg serialization (pure).
      "src/zeros/logging/__tests__/**/*.test.ts",
      // Feedback → Intercom/Linear bridge Worker (fetch handler, mocked APIs).
      "packages/feedback-intercom-webhook/src/__tests__/**/*.test.ts",
    ],
    environment: "node",
    // Install a `navigator` stub before any test module loads — modules under
    // test transitively import @pierre/diffs, which reads `navigator.userAgent`
    // at import time and crashes on Node 20 (CI) where it is undefined. See
    // vitest.setup.ts for the full rationale.
    setupFiles: ["./vitest.setup.ts"],
    // Use `forks` (a child process per worker), NOT `threads` (worker_threads).
    // Two reasons: (1) worktree tests create temp git repos and shell out —
    // not expensive individually, but running ~20 in parallel exhausts file
    // handles on macOS, so we cap workers below; (2) forks is Vitest's own
    // default since v2. (Historically `forks` was also REQUIRED because the git
    // suite loaded @parcel/watcher's native addon — which threw "Module did not
    // self-register" in worker threads — but git/detach.ts switched to pure-JS
    // chokidar in PR #111, so that native-binding constraint no longer applies.)
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
    // Each test spins up a temp repo; allow up to 20s for the slow
    // ones (initial `git init` + first commit can run long on cold
    // CI).
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
