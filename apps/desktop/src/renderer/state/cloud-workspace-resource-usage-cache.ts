import { z } from "zod";
import { WorkspaceResourceUsageIdentitySchema, WorkspaceResourceUsageSchema, type WorkspaceResourceUsage } from "@zeros/protocol/workspace-resource-usage";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";

const OwnerSchema = WorkspaceResourceUsageIdentitySchema.extend({
  accountId: z.string().uuid(), accountGeneration: z.number().int().nonnegative(),
  catalogGeneration: z.number().int().nonnegative(), authorityEpoch: z.number().int().positive(),
  admissionId: z.string().min(1).max(128),
}).strict();
export type CloudWorkspaceResourceUsageOwner = z.infer<typeof OwnerSchema>;
export const CLOUD_RESOURCE_USAGE_MAX_AGE_MS = 3_000;
export const CLOUD_RESOURCE_USAGE_POLL_MS = 4_000;
export function cloudWorkspaceResourceUsageKey(owner: CloudWorkspaceResourceUsageOwner): string {
  return JSON.stringify(OwnerSchema.parse(owner));
}
export function cloudWorkspaceResourceUsageOwnerFromKey(key: string): CloudWorkspaceResourceUsageOwner {
  return OwnerSchema.parse(JSON.parse(key));
}
export function canPollCloudWorkspaceResourceUsage(gates: {
  cloud: boolean; active: boolean; open: boolean; featureActive: boolean; visible: boolean;
  connected: boolean; status: string | undefined; recovery: boolean;
}): boolean {
  return gates.cloud && gates.active && gates.open && gates.featureActive && gates.visible && gates.connected &&
    (gates.status === "ready" || gates.status === "busy") && !gates.recovery;
}
export function isCloudWorkspaceResourceUsageFresh(sample: WorkspaceResourceUsage, now = Date.now()): boolean {
  const age = now - Date.parse(sample.sampledAt);
  return age >= -10_000 && age <= 12_000;
}
type Dependencies = {
  read: (owner: CloudWorkspaceResourceUsageOwner) => Promise<WorkspaceResourceUsage | null>;
  isCurrent: (owner: CloudWorkspaceResourceUsageOwner) => boolean;
  maxEntries?: number;
};
export class CloudWorkspaceResourceUsageCache {
  readonly snapshots: KeyedAsyncCache<WorkspaceResourceUsage | null>;
  constructor(private readonly dependencies: Dependencies) {
    this.snapshots = new KeyedAsyncCache({ maxEntries: dependencies.maxEntries ?? 32,
      reconcile: (previous, next) => JSON.stringify(previous) === JSON.stringify(next) ? previous! : next });
  }
  private assertCurrent(key: string): CloudWorkspaceResourceUsageOwner {
    const owner = cloudWorkspaceResourceUsageOwnerFromKey(key);
    if (!this.dependencies.isCurrent(owner)) {
      this.snapshots.forget(key);
      throw new Error("Cloud resource usage owner changed");
    }
    return owner;
  }
  async fetch(key: string): Promise<WorkspaceResourceUsage | null> {
    const owner = this.assertCurrent(key);
    const value = await this.dependencies.read(owner);
    this.assertCurrent(key);
    if (value === null) return null;
    const sample = WorkspaceResourceUsageSchema.parse(value);
    if (sample.organizationId !== owner.organizationId || sample.workspaceId !== owner.workspaceId ||
        sample.generation !== owner.generation || sample.engineInstanceId !== owner.engineInstanceId)
      throw new Error("Resource usage response changed identity");
    const previous = this.snapshots.peekSnapshot(key).data;
    if (previous && Date.parse(sample.sampledAt) < Date.parse(previous.sampledAt))
      throw new Error("Resource usage response is older than the confirmed sample");
    return sample;
  }
  load(key: string, force = false): Promise<WorkspaceResourceUsage | null> {
    this.assertCurrent(key);
    return this.snapshots.load(key, () => this.fetch(key), { force, maxAgeMs: CLOUD_RESOURCE_USAGE_MAX_AGE_MS });
  }
  prune(): void {
    for (const key of this.snapshots.keys())
      if (!this.dependencies.isCurrent(cloudWorkspaceResourceUsageOwnerFromKey(key))) this.snapshots.forget(key);
  }
}
