// Vitest config for the engine + pure-function modules. Coverage has grown well
// beyond the original git-only scope: see the `include` globs below (engine
// git/agents/transport/pty/files/auth/db/settings/workspace, several
// renderer feature/state suites, the renderer shell, marketing route contracts,
// Electron IPC command handlers, and packages/protocol crypto).
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
      "apps/desktop/src/engine/git/__tests__/**/*.test.ts",
      // Design workspaces: portable document parsing, lint, and MCP contracts.
      "apps/desktop/src/engine/design/__tests__/**/*.test.ts",
      "apps/desktop/src/engine/agents/**/__tests__/**/*.test.ts",
      "apps/desktop/src/renderer/state/__tests__/**/*.test.ts",
      // Native renderer boundary parsers (pure validation, no Electron host).
      "apps/desktop/src/renderer/platform/__tests__/**/*.test.ts",
      // Pure-function @-mention helpers (fuzzy file/folder ranking).
      "apps/desktop/src/renderer/features/agent/__tests__/**/*.test.ts",
      // Feature-owned renderer helpers and interaction contracts.
      "apps/desktop/src/renderer/features/agent-extensions/__tests__/**/*.test.ts",
      "apps/desktop/src/renderer/features/design-workspace/__tests__/**/*.test.ts",
      "apps/desktop/src/renderer/features/repositories/__tests__/**/*.test.ts",
      // Desktop bridge commands and workbench contracts.
      "apps/desktop/electron/ipc/commands/__tests__/**/*.test.ts",
      // App log store: repeat coalescing (storm dedup) in apps/desktop/electron/log-store.ts.
      "apps/desktop/electron/__tests__/**/*.test.ts",
      // Shell, conversation, terminal, PR, and workbench behavior.
      "apps/desktop/src/renderer/shell/**/__tests__/**/*.test.ts",
      // Appearance: unified code-theme registry + diff-theme resolution.
      "apps/desktop/src/renderer/shared/theme/__tests__/**/*.test.ts",
      // Analytics: renderer emit-site PII contract (metadata-only guarantee).
      "apps/desktop/src/renderer/platform/observability/analytics/__tests__/**/*.test.ts",
      // Shared crypto primitives + EncryptedChannel (kept for the future cloud transport).
      "packages/protocol/src/**/__tests__/**/*.test.ts",
      // Headless Design Foundation: schemas, transactions, history, and geometry.
      "packages/design-core/src/**/__tests__/**/*.test.ts",
      // Pure authored HTML/CSS adapter and provenance engine.
      "packages/design-web/src/**/__tests__/**/*.test.ts",
      // Engine transport: local + cloud transport end-to-end.
      "apps/desktop/src/engine/transport/__tests__/**/*.test.ts",
      // Bridge protocol: PTY + workspace request/response round-trips over the socket.
      "apps/desktop/src/renderer/platform/bridge/__tests__/**/*.test.ts",
      // Auth: pure error-mapping (enumeration-neutrality guard).
      "apps/desktop/src/renderer/features/auth/__tests__/**/*.test.ts",
      // Remote Workspace API: service dispatch + write-approval broker.
      "apps/desktop/src/engine/workspace/__tests__/**/*.test.ts",
      // Terminal: engine PTY service (injected spawn, no native binding).
      "apps/desktop/src/engine/pty/__tests__/**/*.test.ts",
      // Run tab: RunManager status engine (fake PTY, hand-driven exits).
      "apps/desktop/src/engine/run/__tests__/**/*.test.ts",
      // Files: bounded read + remote-boundary sensitive-file denylist.
      "apps/desktop/src/engine/files/__tests__/**/*.test.ts",
      // Account-binding: JWT verification (HS256/ES256/RS256).
      "apps/desktop/src/engine/auth/__tests__/**/*.test.ts",
      // Universal storage: the unified engine-owned Zeros DB (schema + migrations).
      "apps/desktop/src/engine/db/__tests__/**/*.test.ts",
      // Engine runtime mode + loopback port range (dev/prod isolation).
      "apps/desktop/src/engine/__tests__/**/*.test.ts",
      // Spawn env: undoing the `npm/pnpm run` that launched the app.
      "apps/desktop/src/engine/env/__tests__/**/*.test.ts",
      // Settings foundation: TOML layers, per-leaf sanitize, provenance resolve.
      "apps/desktop/src/engine/settings/__tests__/**/*.test.ts",
      // Small renderer primitives whose static markup carries accessibility
      // contracts (for example, visible keyboard-focus forwarding).
      "apps/desktop/src/renderer/shared/ui/primitives/__tests__/**/*.test.ts",
      // Renderer settings stores: internal-features allowlist + flag gate.
      "apps/desktop/src/renderer/features/settings/__tests__/**/*.test.ts",
      // Shared renderer lib helpers (e.g. Dashboard card-action state machine).
      "apps/desktop/src/renderer/shared/lib/__tests__/**/*.test.ts",
      // Teams: invite-link parsing (host pinning, token shape).
      "apps/desktop/src/renderer/features/team/__tests__/**/*.test.ts",
      // Structured logging: renderer console-arg serialization (pure).
      "apps/desktop/src/renderer/platform/observability/logging/__tests__/**/*.test.ts",
      // Marketing deep-link routing without a server/router runtime.
      "apps/marketing/src/**/__tests__/**/*.test.ts",
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
      "@": path.resolve(__dirname, "./apps/desktop/src"),
    },
  },
});
