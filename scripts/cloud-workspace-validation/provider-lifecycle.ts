import { randomUUID } from "node:crypto";

import type {
  CloudProviderIdentity,
  CloudProviderObservedState,
  CloudProviderResource,
} from "../../apps/control-plane/src/cloud-workspaces/provider";
import { CloudProviderError } from "../../apps/control-plane/src/cloud-workspaces/provider";
import {
  RESOURCES,
  loadSnapshotAttestation,
  withCloudValidationMutationLock,
} from "./config";
import { makeQualifiedControlPlaneProvider } from "./control-plane-provider";

const STATE_TIMEOUT_MS = 4 * 60_000;
const POLL_MS = 1_000;

type Provider = ReturnType<typeof makeQualifiedControlPlaneProvider>;

async function waitForState(
  provider: Provider,
  resourceId: string,
  expected: ReadonlySet<CloudProviderObservedState>,
  label: string,
): Promise<CloudProviderResource> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    const resource = await provider.inspect(resourceId);
    if (!resource) throw new Error(`${label} disappeared`);
    if (expected.has(resource.state)) return resource;
    if (["failed", "unknown"].includes(resource.state)) {
      throw new Error(`${label} entered ${resource.state}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label} did not converge before its deadline`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function deleteIdentity(
  provider: Provider,
  identity: CloudProviderIdentity,
): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    const resources = await provider.find(identity);
    if (resources.length === 0) return;
    if (resources.length !== 1) {
      throw new Error(
        "provider cleanup found an ambiguous generation identity",
      );
    }
    try {
      await provider.delete(resources[0]!.resourceId);
    } catch (error) {
      if (!(error instanceof CloudProviderError) || !error.retryable)
        throw error;
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("provider generation inventory remained after deletion");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function runProviderLifecycle() {
  const provider = makeQualifiedControlPlaneProvider();
  const snapshot = loadSnapshotAttestation();
  const workspaceId = randomUUID();
  const sourceIdentity = { workspaceId, generation: 1 } as const;
  const candidateIdentity = { workspaceId, generation: 2 } as const;
  const identities = [candidateIdentity, sourceIdentity];
  const input = (identity: CloudProviderIdentity) => ({
    ...identity,
    imageRef: snapshot.snapshotId,
    architecture: "linux/amd64" as const,
    cpuMillicores: RESOURCES.cpu * 1_000,
    memoryMiB: RESOURCES.memory * 1_024,
    storageMiB: RESOURCES.disk * 1_024,
    idempotencyKey: randomUUID(),
  });
  let primaryFailure: unknown = null;

  try {
    console.log(
      "\n  Creating a managed source generation through the production adapter…",
    );
    const source = await provider.create(input(sourceIdentity));
    await waitForState(
      provider,
      source.resourceId,
      new Set(["running"]),
      "source generation",
    );

    console.log("  Verifying stop → wake convergence…");
    await provider.stop(source.resourceId);
    await waitForState(
      provider,
      source.resourceId,
      new Set(["stopped"]),
      "stopped source generation",
    );
    await provider.start(source.resourceId);
    await waitForState(
      provider,
      source.resourceId,
      new Set(["running"]),
      "woken source generation",
    );

    console.log("  Draining source before candidate provisioning…");
    await provider.stop(source.resourceId);
    await waitForState(
      provider,
      source.resourceId,
      new Set(["stopped"]),
      "drained source generation",
    );

    const candidate = await provider.create(input(candidateIdentity));
    await waitForState(
      provider,
      candidate.resourceId,
      new Set(["running"]),
      "candidate generation",
    );

    console.log(
      "  Rejecting candidate, proving deletion, then waking the source…",
    );
    await deleteIdentity(provider, candidateIdentity);
    await provider.start(source.resourceId);
    await waitForState(
      provider,
      source.resourceId,
      new Set(["running"]),
      "rolled-back source generation",
    );

    console.log(
      "\n  \x1b[32m✓ provider lifecycle matrix passed\x1b[0m — stop/wake and drain → candidate delete → source wake converged.\n",
    );
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const identity of identities) {
      try {
        await deleteIdentity(provider, identity);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (primaryFailure && cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        "provider lifecycle failed and managed generation cleanup was incomplete",
      );
    }
    if (primaryFailure) throw primaryFailure;
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        "provider lifecycle passed but managed generation cleanup was incomplete",
      );
    }
  }
}

async function main() {
  await withCloudValidationMutationLock(runProviderLifecycle);
}

main().catch((error) => {
  console.error("\n  ✗ provider lifecycle qualification failed:\n", error);
  process.exit(1);
});
