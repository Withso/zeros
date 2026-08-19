// Maintains the provider-authenticated ingress pool used by ZSR dev-server
// previews. This process is external to the worker by design: DAYTONA_API_KEY
// never enters the sandbox, engine, agent environment, or renderer.

import {
  CLOUD_PREVIEW_LINK_TTL_SECONDS,
  collectCloudAccountBindingEnv,
  loadState,
  makeDaytona,
  withCloudValidationMutationLock,
} from "./config";
import {
  acknowledgeQualifiedCloudGithubRefreshRequest,
  installQualifiedCloudGithubCredential,
  readQualifiedCloudGithubRefreshRequest,
  refreshQualifiedCloudEngineIngress,
  refreshQualifiedCloudPreviewLinks,
} from "./runtime";
import {
  resolveQualifiedCloudGithubCredential,
  resolveQualifiedCloudGithubCredentialAfterInvalidation,
} from "./github-coordinator";

// An engine-side Git retry waits 20 seconds for a replacement credential. Poll
// fast enough that mint + root installation normally complete inside that
// window; this loop performs no preview-provider call while ingress is fresh.
const POLL_MS = 5_000;
const RETRY_MS = 15_000;
const RENEW_AHEAD_MS = 6 * 60 * 60_000;
const GITHUB_RENEW_AHEAD_MS = 10 * 60_000;

let stopping = false;
let wakeWait: (() => void) | null = null;

function requestStop(): void {
  stopping = true;
  wakeWait?.();
}

async function wait(ms: number): Promise<void> {
  if (stopping) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wakeWait = null;
      resolve();
    }, ms);
    wakeWait = () => {
      clearTimeout(timer);
      wakeWait = null;
      resolve();
    };
  });
}

async function main(): Promise<void> {
  if (CLOUD_PREVIEW_LINK_TTL_SECONDS !== 24 * 60 * 60) {
    throw new Error("cloud preview coordinator requires the qualified 24h TTL");
  }
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  const initial = loadState();
  const daytona = makeDaytona();
  const sandbox = await daytona.get(initial.sandboxId);
  console.log("\n  ZSR cloud preview coordinator is active.");
  console.log(
    "  Signed ingress and short-lived GitHub working credentials rotate before expiry; refresh authority remains outside the worker.",
  );
  console.log("  Stop with Ctrl-C only when the workspace is no longer in use.\n");

  let consecutiveFailures = 0;
  let githubRefreshAt = 0;
  while (!stopping) {
    try {
      await withCloudValidationMutationLock(async () => {
        let state = loadState();
        if (state.sandboxId !== initial.sandboxId) {
          throw new Error("cloud validation workspace identity changed");
        }
        state = await refreshQualifiedCloudEngineIngress(sandbox, state, {
          renewAheadMs: RENEW_AHEAD_MS,
        });
        state = await refreshQualifiedCloudPreviewLinks(sandbox, state, {
          renewAheadMs: RENEW_AHEAD_MS,
        });
        const now = Date.now();
        const accountBinding = collectCloudAccountBindingEnv();
        const refreshRequest =
          await readQualifiedCloudGithubRefreshRequest(
            sandbox,
            accountBinding.ZEROS_CLOUD_OWNER_SUB,
          );
        if (refreshRequest || now >= githubRefreshAt) {
          // A GitHub App installation grant is renewable. Explicit PAT/gh-cli
          // credentials are not: reinstalling the exact rejected bearer would
          // create a retry loop and resurrect it after an engine restart, so an
          // invalidation publishes an explicit null projection until the
          // operator restarts this coordinator with a replacement.
          const credential = refreshRequest
            ? await resolveQualifiedCloudGithubCredentialAfterInvalidation(
                refreshRequest.method,
              )
            : await resolveQualifiedCloudGithubCredential();
          const installed = await installQualifiedCloudGithubCredential(
            sandbox,
            {
              ownerSubject: accountBinding.ZEROS_CLOUD_OWNER_SUB,
              credential,
              method:
                credential?.method ?? refreshRequest?.method ?? "pat",
            },
          );
          if (refreshRequest) {
            await acknowledgeQualifiedCloudGithubRefreshRequest(
              sandbox,
              refreshRequest.generation,
            );
          }
          githubRefreshAt = credential
            ? Math.max(now + 60_000, installed.expiresAt - GITHUB_RENEW_AHEAD_MS)
            : now + 6 * 60 * 60_000;
        }
      });
      consecutiveFailures = 0;
      await wait(POLL_MS);
    } catch {
      consecutiveFailures += 1;
      // Provider errors may echo bearer URLs. Keep the durable/operator output
      // generic and rely on provider-side request IDs for private diagnosis.
      console.error(
        `  cloud capability coordinator retry ${consecutiveFailures}: provider/root rotation did not complete`,
      );
      await wait(RETRY_MS);
    }
  }
  console.log("\n  ZSR cloud preview coordinator stopped.\n");
}

main().catch(() => {
  console.error("\n  ✗ cloud preview coordinator could not start safely.\n");
  process.exitCode = 1;
});
