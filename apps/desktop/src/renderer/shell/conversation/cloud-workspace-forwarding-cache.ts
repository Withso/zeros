import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import type { CloudServiceContext, CloudWorkspaceAccessTarget, CloudWorkspacePortForwardingState } from "../../platform/cloud-workspace-access";

export type CloudWorkspaceForwardingOwner = CloudWorkspaceAccessTarget & CloudServiceContext & {
  account: string; catalog: number; generation: number;
};
export const cloudWorkspaceForwardingKey = (owner: CloudWorkspaceForwardingOwner) => JSON.stringify([
  owner.account, owner.catalog, owner.organizationId, owner.workspaceId, owner.generation, owner.authorityId, owner.deviceId, owner.keyVersion,
]);
function ownerFromKey(key: string): CloudWorkspaceForwardingOwner {
  const [account, catalog, organizationId, workspaceId, generation, authorityId, deviceId, keyVersion] = JSON.parse(key) as
    [string, number, string, string, number, string, string | null, number | null];
  return { account, catalog, organizationId, workspaceId, generation, authorityId, deviceId, keyVersion };
}

/** Open port surfaces share native preferences without retaining another
 * account, device authority or runtime generation's response. */
export class CloudWorkspaceForwardingCache {
  readonly snapshots = new KeyedAsyncCache<CloudWorkspacePortForwardingState>({ maxEntries: 32,
    reconcile: (previous, next) => previous?.forwardingEnabled === next.forwardingEnabled &&
      previous.autoForwardEnabled === next.autoForwardEnabled ? previous : next });
  constructor(private readonly dependencies: {
    isCurrent: (owner: CloudWorkspaceForwardingOwner) => boolean;
    read: (owner: CloudWorkspaceForwardingOwner) => Promise<CloudWorkspacePortForwardingState>;
    write: (owner: CloudWorkspaceForwardingOwner, patch: Partial<CloudWorkspacePortForwardingState>) => Promise<CloudWorkspacePortForwardingState>;
  }) {}
  private owner(key: string) {
    const owner = ownerFromKey(key);
    if (!this.dependencies.isCurrent(owner)) throw new Error("The cloud workspace access owner changed.");
    return owner;
  }
  async fetch(key: string) {
    const owner = this.owner(key);
    const state = await this.dependencies.read(owner);
    this.owner(key);
    return state;
  }
  load(key: string, force = false) {
    return this.snapshots.load(key, () => this.fetch(key), { maxAgeMs: 5_000, force });
  }
  async write(key: string, patch: Partial<CloudWorkspacePortForwardingState>) {
    const owner = this.owner(key);
    try {
      const state = await this.dependencies.write(owner, patch);
      this.owner(key);
      this.snapshots.setData(key, state);
      return state;
    } catch (error) {
      if (this.dependencies.isCurrent(owner)) this.snapshots.invalidate(key);
      throw error;
    }
  }
  prune() {
    for (const key of this.snapshots.keys())
      if (!this.dependencies.isCurrent(ownerFromKey(key))) this.snapshots.forget(key);
  }
}
