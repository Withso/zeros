#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { runExplicitVitest } from "./run-explicit-vitest.mjs";

/**
 * Deterministic source-level qualification for the complete native + kernel
 * execution-boundary lifecycle. The script name is a compatibility contract.
 * Keep this list explicit: run-explicit-vitest rejects missing, duplicate,
 * symlinked, or out-of-repository entries, while repository-layout.test.ts
 * requires every boundary and gateway suite to remain represented as new
 * files are added.
 */
export const ZSR_CONTRACT_TEST_FILES = Object.freeze([
  "apps/desktop/src/engine/__tests__/agent-cancel-stop.test.ts",
  "apps/desktop/src/engine/__tests__/agent-session-reload.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-adapter-recovery.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-boundary-ports.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-boundary-retirement-recovery.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-boundary-status.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-browser-tools.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-cwd-hint.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-default-boundary.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-end-session.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-identity.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-initialize-singleflight.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-local-services.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-mcp.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-native-instructions.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-provider-oneshot-boundary.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-provider-probe-boundary.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-session-readiness.test.ts",
  "apps/desktop/src/engine/agents/__tests__/gateway-warm-session-boundary.test.ts",
  "apps/desktop/src/engine/agents/__tests__/territory-resolution.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/claude-oauth-authority.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/cloud-container-worker.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/cloud-preview-links.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/cloud-worker-config.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/design-watch-isolation.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/git-dispatch.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/git-integration-broker.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/host-boundary.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/macos-process-domain.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/policy.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/repo-task-boundary.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/routing-boundary.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/status.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/utility-boundary-pool.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/warm-session-boundary-pool.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/zsr-boundary.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/zsr-preview-gateway.test.ts",
  "apps/desktop/src/engine/agents/containment/__tests__/zsr-supervisor.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/agent-prewarm-singleflight.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/agent-registry-verification.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/chat-title-scheduler.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/composer-responsive-contract.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/permission-mode-display.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/session-admission-policy.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/session-reload-lifecycle.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/tail-indicators.test.ts",
  "apps/desktop/src/renderer/features/agent/__tests__/turn-footer.test.ts",
]);

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = runExplicitVitest([...ZSR_CONTRACT_TEST_FILES]);
  } catch (error) {
    console.error(
      `✖ scripts/run-zsr-contract-tests.mjs — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}
