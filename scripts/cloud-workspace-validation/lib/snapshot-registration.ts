import { DaytonaNotFoundError, type Daytona, type Snapshot } from "@daytona/sdk";
import type { SnapshotInventory } from "./snapshot-allocation";
import type { SnapshotResources } from "./snapshot-placement";

export function snapshotInventory(service: Daytona["snapshot"]): SnapshotInventory<Snapshot> {
  return {
    async *list() {
      for (let page = 1; page <= 100; page++) {
        const result = await service.list(page, 100);
        yield* result.items;
        if (page >= result.totalPages) return;
      }
      throw new Error("Snapshot cleanup inventory exceeded its bound");
    },
    async get(id) {
      try { return await service.get(id); }
      catch (error) { if (error instanceof DaytonaNotFoundError) return null; throw error; }
    },
    delete: snapshot => service.delete(snapshot),
  };
}

/** The SDK's create convenience call waits for the complete build. Persisting
 * the initial REST acknowledgement is necessary for cleanup after build errors.
 * This body follows the pinned 0.214 Snapshot API schema for published images. */
export async function createVmSnapshotAcknowledged(input: {
  apiUrl: string; apiKey: string; name: string; registryImage: string;
  region: string; resources: SnapshotResources; signal: AbortSignal;
}): Promise<Snapshot> {
  const url = new URL(input.apiUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Snapshot registration requires a secure API origin");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/snapshots`;
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: input.signal,
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({name:input.name,imageName:input.registryImage,regionId:input.region,sandboxClass:"linux-vm",
      cpu:input.resources.cpu,memory:input.resources.memory,disk:input.resources.disk}),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Snapshot registration failed (${response.status})`); }
  if (!response.body) throw new Error("Snapshot registration returned no acknowledgement");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try {
    for (;;) { const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;
      if(bytes>1024*1024)throw new Error("Snapshot acknowledgement exceeded its bound");chunks.push(next.value); }
  } catch(error) {await reader.cancel().catch(()=>{});throw error;} finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Snapshot;
}
