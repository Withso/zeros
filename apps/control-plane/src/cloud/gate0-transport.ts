import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CloudV2Compute } from "./boat.js";
import { CLOUD_V2_WORKER_PORT } from "./contract.js";
import { Gate0Failure } from "./gate0.js";
import type { CloudV2WorkerSigner } from "./worker-auth.js";

export type Gate0TransportWorkspace = { id: string; boatSandboxId?: string | null | undefined };

const TimingSchema = z.object({
  agent: z.enum(["codex", "claude", "cursor"]), chat: z.string().regex(/^[A-Za-z0-9_-]{1,8}$/),
  phase: z.enum(["open", "turn"]), elapsedMs: z.number().int().nonnegative(),
  stage: z.enum(["open_received", "turn_received", "process_ready", "driver_ready", "turn_sent", "first_provider_event", "turn_done"]),
}).strict();
export type Gate0Timing = z.infer<typeof TimingSchema>;

/** Read only this probe's VM. Whitelist closed timing records before any
 * output: a service journal may contain unrelated private diagnostics. */
export function createGate0TimingReader(options: { compute: Pick<CloudV2Compute, "exec"> }): (workspace: Gate0TransportWorkspace) => Promise<Gate0Timing[]> {
  return async workspace => {
    try {
      if (!workspace.boatSandboxId) throw new Error();
      const result = await options.compute.exec(workspace.boatSandboxId,
        "sudo -n journalctl -u zeros-worker.service -n 256 -o cat --no-pager", 10);
      if (result.exitCode !== 0 || result.timedOut || result.stdout.length > 131072) throw new Error();
      const records: Gate0Timing[] = [], prefix = "cloud-worker timing ";
      for (const line of result.stdout.split("\n")) {
        if (!line.startsWith(prefix)) continue;
        try {
          const parsed = TimingSchema.safeParse(JSON.parse(line.slice(prefix.length)));
          if (parsed.success) records.push(parsed.data);
        } catch { /* An unrelated/malformed log line is never probe output. */ }
      }
      return records;
    } catch { throw new Gate0Failure("worker_timings"); }
  };
}

/** Operator-only checks on the probe's existing VM. No create/resume calls;
 * private route tokens and signatures never enter app responses or logs. */
export function createGate0TransportProbe(options: {
  compute: Pick<CloudV2Compute, "exec" | "hostPort">;
  signer: Pick<CloudV2WorkerSigner, "mint">;
  fetch?: typeof fetch;
}): (workspace: Gate0TransportWorkspace) => Promise<void> {
  return async workspace => {
    if (!workspace.boatSandboxId) throw new Gate0Failure("worker_sandbox_identity");
    // Boat's in-VM port agent forwards the protected route from the VM's own
    // interface addresses, so the check is the worker's own sockets: exactly
    // one, on loopback. Nothing may hold the port's wildcard address.
    let binding;
    try {
      binding = await options.compute.exec(workspace.boatSandboxId,
        `echo "worker-pid=$(systemctl show -p MainPID --value zeros-worker.service)"; sudo -n ss -H -ltnp 'sport = :${CLOUD_V2_WORKER_PORT}'`, 10);
    } catch { throw new Gate0Failure("worker_loopback"); }
    const [first = "", ...rows] = binding.stdout.trim().split("\n").filter(Boolean);
    const pid = /^worker-pid=([1-9]\d*)$/.exec(first.trim())?.[1];
    const listeners = rows.map(line => ({ line, address: line.trim().split(/\s+/)[3] ?? "" }));
    const own = pid ? listeners.filter(row => row.line.includes(`pid=${pid},`)) : [];
    const wildcard = listeners.some(row => /^(0\.0\.0\.0|\*|\[::\])(%[^:\]]+)?:/.test(row.address));
    if (binding.exitCode !== 0 || binding.timedOut || wildcard || own.length !== 1 || own[0]!.address !== `127.0.0.1:${CLOUD_V2_WORKER_PORT}`)
      throw new Gate0Failure("worker_loopback");
    let route;
    try { route = await options.compute.hostPort(workspace.boatSandboxId, { port: CLOUD_V2_WORKER_PORT, localhost: true, title: "Zeros worker" }); }
    catch { throw new Gate0Failure("worker_private_route"); }
    const request = async (stage: string, status: number, headers?: Record<string, string>) => {
      try {
        const response = await (options.fetch ?? fetch)(new URL("/v2/worker/health", route.url), {
          redirect: "error", signal: AbortSignal.timeout(5000), ...(headers ? { headers } : {}),
        });
        await response.body?.cancel();
        if (response.status !== status) throw new Error();
      } catch { throw new Gate0Failure(stage); }
    };
    await request("worker_port_cookie", 403);
    const cookie = { Cookie: `_port_auth=${route.token}` };
    await request("worker_port_auth", 401, cookie);
    // A fresh valid signature for another process must fail, independently of
    // expiry or replay. The ordinary bridge next proves the current boot works.
    await request("worker_stale_boot", 401, { ...cookie, "X-Zeros-Worker-Auth": options.signer.mint(workspace.id, randomUUID()) });
  };
}
