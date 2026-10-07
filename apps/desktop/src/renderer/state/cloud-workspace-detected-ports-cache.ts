import { z } from "zod";
import { CloudWorkspaceDetectedPortsSchema, type CloudWorkspaceDetectedPorts } from "../platform/cloud-workspaces";
import { ControlPlaneError } from "../features/team/control-plane";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";

const OwnerSchema = z.object({
  accountId: z.string().uuid(), accountGeneration: z.number().int().nonnegative(), catalogGeneration: z.number().int().nonnegative(),
  organizationId: z.string().uuid(), workspaceId: z.string().uuid(), generation: z.number().int().positive(),
}).strict();
export type CloudWorkspaceDetectedPortsOwner = z.infer<typeof OwnerSchema>;
export const CLOUD_DETECTED_PORTS_MAX_AGE_MS = 3_000;
export function cloudWorkspaceDetectedPortsKey(owner: CloudWorkspaceDetectedPortsOwner): string {
  return JSON.stringify(OwnerSchema.parse(owner));
}
export function cloudWorkspaceDetectedPortsOwnerFromKey(key: string): CloudWorkspaceDetectedPortsOwner {
  return OwnerSchema.parse(JSON.parse(key));
}
type Dependencies = {
  read: (owner: CloudWorkspaceDetectedPortsOwner) => Promise<CloudWorkspaceDetectedPorts>;
  isCurrent: (owner: CloudWorkspaceDetectedPortsOwner) => boolean;
  maxEntries?: number;
};
export class CloudWorkspaceDetectedPortsCache {
  readonly snapshots: KeyedAsyncCache<CloudWorkspaceDetectedPorts>;
  constructor(private readonly dependencies: Dependencies) {
    this.snapshots = new KeyedAsyncCache({ maxEntries: dependencies.maxEntries ?? 32,
      reconcile: (previous, next) => JSON.stringify(previous) === JSON.stringify(next) ? previous! : next });
  }
  private assertCurrent(key: string): CloudWorkspaceDetectedPortsOwner {
    const owner = cloudWorkspaceDetectedPortsOwnerFromKey(key);
    if (!this.dependencies.isCurrent(owner)) {
      this.snapshots.forget(key); throw new Error("Cloud port observation owner changed");
    }
    return owner;
  }
  async fetch(key: string): Promise<CloudWorkspaceDetectedPorts> {
    const owner = this.assertCurrent(key);
    try {
      const result = CloudWorkspaceDetectedPortsSchema.parse(await this.dependencies.read(owner));
      this.assertCurrent(key);
      if (result.organizationId !== owner.organizationId || result.workspaceId !== owner.workspaceId || result.generation !== owner.generation)
        throw new Error("Cloud port observation response changed identity");
      const previous = this.snapshots.peekSnapshot(key).data;
      if (previous?.observedAt && result.observedAt && Date.parse(result.observedAt) < Date.parse(previous.observedAt))
        throw new Error("Cloud port observation response is older than the confirmed scan");
      return result;
    } catch (error) {
      if (error instanceof ControlPlaneError && [403, 404].includes(error.status)) this.snapshots.forget(key);
      throw error;
    }
  }
  load(key: string, force = false): Promise<CloudWorkspaceDetectedPorts> {
    this.assertCurrent(key);
    return this.snapshots.load(key, () => this.fetch(key), { force, maxAgeMs: CLOUD_DETECTED_PORTS_MAX_AGE_MS });
  }
  prune(): void {
    for (const key of this.snapshots.keys())
      if (!this.dependencies.isCurrent(cloudWorkspaceDetectedPortsOwnerFromKey(key))) this.snapshots.forget(key);
  }
}
