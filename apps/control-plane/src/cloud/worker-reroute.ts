import type { CloudV2Compute } from "./boat.js";
import { CLOUD_V2_WORKER_PORT } from "./contract.js";
import type { CloudV2Store } from "./store.js";
import type { WorkerRoute } from "./worker-connection.js";

export type WorkerRerouteDeps = {
  compute: Pick<CloudV2Compute, "hostPort">;
  store: Pick<CloudV2Store, "replaceWorkerRoute">;
  sealPortToken(token: string, workspaceId: string): unknown;
};

/** The relay's second request for a running workspace's route, as the create asks for it: the same address and token
 * coming back need nothing stored; a different one is kept while the workspace still runs on that machine. Resolves
 * whether the route is now current. */
export function workerReroute(deps: WorkerRerouteDeps): (route: WorkerRoute) => Promise<boolean> {
  return async route => {
    const sandboxId = route.workspace.boatSandboxId;
    if (!sandboxId || route.workspace.state !== "running" || !route.url || !route.token) return false;
    const hosted = await deps.compute.hostPort(sandboxId, { port: CLOUD_V2_WORKER_PORT, localhost: true, title: "Zeros worker" });
    if (hosted.url === route.url && hosted.token === route.token) return true;
    return deps.store.replaceWorkerRoute(route.workspace.id, sandboxId, hosted.url, deps.sealPortToken(hosted.token, route.workspace.id));
  };
}
