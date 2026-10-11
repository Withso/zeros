import type { BoatApiClient } from "./boat-client.js";

type Owner = { organizationSlug: string; organizationId: string; channel: string };
export type BoatDisplayName = string | null | Promise<string | null>;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function part(value: string, fallback: string, limit: number): string {
  return (slug(value) || slug(fallback)).slice(0, limit).replace(/-+$/g, "");
}
const ownerPart = (input: Owner) => part(input.organizationSlug, input.organizationId.slice(0, 12), 46);
const channelPart = (channel: string) => part(channel, "development", 16);

export function boatComputerDisplayName(input: Owner & { version: number | string }): string {
  if (!/^[1-9][0-9]{0,18}$/.test(String(input.version))) throw new Error("Invalid Computer version for Boat display name");
  return `${ownerPart(input)}-${channelPart(input.channel)}-computer-v${input.version}`;
}

export function boatWorkspaceDisplayName(input: Owner & { workspaceSlug: string; workspaceId: string }): string {
  // 46 + 16 + 9 + 46 + three separators = Boat's 120-character limit.
  return `${ownerPart(input)}-${channelPart(input.channel)}-workspace-${part(input.workspaceSlug, input.workspaceId.slice(0, 12), 46)}`;
}

export function boatRuntimeDisplayName(channel: string, purpose: "build" | "check" | "qualify"): string {
  return `zeros-${channelPart(channel)}-runtime-${purpose}`;
}

/** Start without awaiting, after binding and wallet verification. Labels never
 * participate in create digests, ownership, admission or cleanup. */
export async function setBoatDisplayName(client: Pick<BoatApiClient, "request">, sandboxId: string,
  resolveName: () => BoatDisplayName): Promise<void> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(async () => {
        const name = await resolveName();
        if (controller.signal.aborted || !name || name.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return;
        await client.request(`/sandboxes/${sandboxId}`, {
          method: "PATCH", body: { name }, timeoutMs: 1000, signal: controller.signal,
        });
      }),
      new Promise<void>(resolve => {
        timeout = setTimeout(() => { controller.abort(); resolve(); }, 1000);
        timeout.unref();
      }),
    ]);
  } catch { /* Best effort; never turn a confirmed allocation into a failed create. */ }
  finally { clearTimeout(timeout); }
}
