import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { ResidentPtyHost } from "./resident-host";
import { ResidentEngineAuthoritySchema } from "./resident-protocol";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const BootstrapSchema = z.object({
  hostId: z.uuid(), organizationId: z.uuid(), workspaceId: z.uuid(),
}).strict();
export type ResidentBootstrap = z.infer<typeof BootstrapSchema>;
const ControlSchema = z.discriminatedUnion("op", [
  z.object({ id, op: z.literal("start"), identity: BootstrapSchema }).strict(),
  z.object({ id, op: z.literal("authorize"), authority: ResidentEngineAuthoritySchema }).strict(),
  z.object({ id, op: z.literal("revoke"), fence: id }).strict(),
  z.object({ id, op: z.literal("ping") }).strict(),
  z.object({ id, op: z.literal("stop") }).strict(),
]);

/** Only the root supervisor inherits these pipes. No control operation is
 * reachable from the engine's Unix socket. Losing this owner shuts down the
 * host; the outer launcher then drains its complete kernel workload scope. */
export async function runResidentControl(input: Readable, output: Writable,
  create: (identity: ResidentBootstrap) => ResidentPtyHost): Promise<void> {
  let host: ResidentPtyHost | undefined;
  let pending = "", stopped = false;
  try {
    for await (const chunk of input) {
      pending += String(chunk);
      if (Buffer.byteLength(pending) > 16 * 1024) throw new Error("Resident control rejected");
      for (let end; (end = pending.indexOf("\n")) !== -1;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const parsed = ControlSchema.safeParse(JSON.parse(line));
        if (!parsed.success) throw new Error("Resident control rejected");
        const request = parsed.data;
        if (request.op === "start") {
          if (host) throw new Error("Resident control rejected");
          host = create(request.identity); await host.start();
        } else {
          if (!host) throw new Error("Resident control rejected");
          if (request.op === "authorize") host.authorize(request.authority);
          if (request.op === "revoke") host.revoke(request.fence);
          if (request.op === "stop") { await host.stop(); stopped = true; }
        }
        await new Promise<void>((resolve, reject) => output.write(
          JSON.stringify({ id: request.id, ok: true }) + "\n", error => error ? reject(error) : resolve()));
        if (stopped) return;
      }
    }
  } finally { await host?.stop(); }
}
