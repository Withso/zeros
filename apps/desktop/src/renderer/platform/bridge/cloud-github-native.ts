import { cloudGithubNativeGrantRequestSchema, cloudGithubWriteGrantSchema } from "@zeros/protocol/github-auth";
import { nativeInvoke } from "../runtime";
import type { RuntimeClient } from "./ws-client";

/** Registered only on a cloud connection. Electron's existing connected
 * GitHub courier adds the user token; only the one-operation grant comes back. */
export function installCloudGithubNative(client: Pick<RuntimeClient, "on" | "onStatusChange" | "request">,
  scope: { organizationId: string; workspaceId: string; generation: number },
  prepare: (input: Record<string, unknown>) => Promise<unknown> = input => nativeInvoke("gh_cloud", input),
): () => void {
  let stopped = false;
  const pending = new Set<string>();
  const ready = () => { if (!stopped) void client.request({ type: "WORKSPACE_REQUEST", op: "github.nativeGrant", params: { kind: "ready" } }).catch(() => {}); };
  const off = client.on("GITHUB_NATIVE_GRANT_REQUEST", message => {
    const parsed = cloudGithubNativeGrantRequestSchema.safeParse("request" in message ? message.request : null);
    if (!parsed.success || stopped) return;
    const request = parsed.data;
    if (request.organizationId !== scope.organizationId || request.workspaceId !== scope.workspaceId || request.generation !== scope.generation ||
        request.native.generation !== request.generation || request.native.engineInstanceId !== request.engineInstanceId ||
        pending.has(request.native.requestId) || pending.size >= 16) return;
    const id = request.native.requestId;
    pending.add(id);
    void (async () => {
      let grant: string | null = null;
      try {
        const result = await prepare({ action: "prepareWrite", organizationId: scope.organizationId, workspaceId: scope.workspaceId,
          operation: request.operation, paramsSha256: request.paramsSha256, native: request.native });
        grant = cloudGithubWriteGrantSchema.parse(result).grant;
      } catch { /* Never send bearer material or upstream error text to the VM. */ }
      finally { pending.delete(id); }
      if (!stopped) await client.request({ type: "WORKSPACE_REQUEST", op: "github.nativeGrant", params: { kind: "reply", requestId: id, grant } }).catch(() => {});
    })();
  });
  const offStatus = client.onStatusChange(status => { if (status === "connected") ready(); });
  ready();
  return () => { stopped = true; off(); offStatus(); pending.clear(); };
}
