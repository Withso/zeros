import { useCallback } from "react";
import {
  changeCloudGithubConnection, cloudGithubConnectionCache, cloudGithubConnectionKey, readCloudGithubConnection,
} from "../../platform/cloud-github-connection";
import { useRecoveringRead } from "../../state/use-recovering-read";

export interface GithubSettingsOwner { userId: string; organizationId: string; name: string }

export function useSharedGithub(owner: GithubSettingsOwner | undefined, active: boolean) {
  const key = owner ? cloudGithubConnectionKey(owner.userId, owner.organizationId) : null;
  const read = useRecoveringRead(cloudGithubConnectionCache, key, value => {
    const [user, org] = JSON.parse(value) as [string, string];
    return readCloudGithubConnection(user, org);
  }, { enabled: active && !!owner, maxAgeMs: 30_000 });
  const target = () => {
    if (!owner || !read.data?.sharedDesktopApp || read.readError) throw new Error("Refresh the cloud GitHub connection and try again.");
    return { userId: owner.userId, organizationId: owner.organizationId, expected: read.data.generation };
  };
  const change = (action: Parameters<typeof changeCloudGithubConnection>[3]) => {
    const { userId, organizationId, expected } = target();
    return changeCloudGithubConnection(userId, organizationId, expected, action);
  };
  const invalidate = useCallback(() => { if (key) cloudGithubConnectionCache.invalidate(key); }, [key]);
  return { read, target, change, invalidate };
}
