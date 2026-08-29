import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  AdmissionControl,
  BoundaryProcess,
  BoundaryProcessExit,
  BoundaryProbeResult,
  BoundaryRequest,
  BoundarySpawnRequest,
  ExecutionBoundary,
  PortLease,
  PortMapping,
  PreparedBoundary,
  TerritoryGeneration,
} from "../../containment/types";
import { boundaryParityRestrictions } from "../../containment/status";

export interface TestExecutionBoundaryOptions {
  probeResult?: BoundaryProbeResult;
  prepareError?: Error;
  stopError?: Error;
  /** Optional behavioral-attestation result exposed by the prepared test
   * boundary. Production boundaries own the same promise; tests can hold it
   * pending to prove provider startup does not wait for the canary. */
  attestation?: Promise<void> | ((request: BoundaryRequest) => Promise<void>);
  onProbe?: (request: BoundaryRequest) => void;
  onPrepare?: (request: BoundaryRequest, control?: AdmissionControl) => void;
  onStop?: (request: BoundaryRequest) => void;
}

function trackedProcess(child: ChildProcess): BoundaryProcess {
  if (!child.pid) throw new Error("test boundary child has no pid");
  const exited = new Promise<BoundaryProcessExit>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => exited,
    signal: async (signal) => {
      child.kill(signal);
    },
    stopAndProve: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

function testProcessGroupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function waitForTestProcessGroup(
  pid: number,
  timeoutMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (testProcessGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function trackedProcessGroup(pid: number): BoundaryProcess {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") {
    throw new Error("test boundary process group has an invalid pid");
  }
  let stopPromise: Promise<void> | null = null;
  const signal = async (value: NodeJS.Signals): Promise<void> => {
    try {
      process.kill(-pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  return {
    pid,
    stdin: null,
    stdout: null,
    stderr: null,
    wait: async () => {
      while (testProcessGroupExists(pid)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      return { code: null, signal: null };
    },
    signal,
    stopAndProve: () => {
      stopPromise ??= (async () => {
        if (!testProcessGroupExists(pid)) return;
        await signal("SIGTERM");
        if (await waitForTestProcessGroup(pid)) return;
        await signal("SIGKILL");
        if (!(await waitForTestProcessGroup(pid))) {
          throw new Error("test boundary process group survived SIGKILL");
        }
      })();
      return stopPromise;
    },
  };
}

/** Explicit unit-test backend. Production never selects this implementation:
 * gateway tests inject it so they can test routing without requiring the test
 * runner's host to support Seatbelt/bubblewrap. */
export function testExecutionBoundary(
  options: TestExecutionBoundaryOptions = {},
): ExecutionBoundary {
  return {
    backend: "zeros-srt",
    probe: async (request) => {
      options.onProbe?.(request);
      return (
        options.probeResult ?? {
          backend: "zeros-srt",
          available: true,
          secureNestedIsolation: true,
          reasons: [],
        }
      );
    },
    prepare: async (
      request: BoundaryRequest,
      control?: AdmissionControl,
    ): Promise<PreparedBoundary> => {
      options.onProbe?.(request);
      if (
        options.probeResult &&
        (!options.probeResult.available ||
          !options.probeResult.secureNestedIsolation)
      ) {
        throw new Error(
          options.probeResult.reasons.join("; ") ||
            "test execution boundary is unavailable",
        );
      }
      if (options.onPrepare) {
        // Preserve arity for the many callers asserting
        // `toHaveBeenCalledWith(request)` — an explicit trailing `undefined`
        // would fail those.
        if (control === undefined) options.onPrepare(request);
        else options.onPrepare(request, control);
      }
      if (options.prepareError) throw options.prepareError;
      const generation = `test-${randomUUID()}` as TerritoryGeneration;
      const restrictions = boundaryParityRestrictions(request);
      const processes = new Set<BoundaryProcess>();
      const leases = new Set<{ revoke(): Promise<void> }>();
      const ports = new Map<string, PortMapping>();
      const portObservers = new Set<
        (snapshot: readonly PortMapping[]) => void
      >();
      const publishPorts = () => {
        const snapshot = [...ports.values()];
        for (const observer of portObservers) observer(snapshot);
      };
      let revoked = false;
      const attestation =
        typeof options.attestation === "function"
          ? options.attestation(request)
          : (options.attestation ?? Promise.resolve());
      // The production boundary owns a rejection sink until the gateway
      // subscribes. Mirror that contract so a deliberately rejected deferred
      // does not become a test-runner-level unhandled rejection.
      void attestation.catch(() => undefined);
      const trackProcess = (child: ChildProcess): BoundaryProcess => {
        const process = trackedProcess(child);
        processes.add(process);
        void process.wait().finally(() => processes.delete(process));
        return process;
      };
      const trackProcessGroup = (pid: number): BoundaryProcess => {
        const tracked = trackedProcessGroup(pid);
        processes.add(tracked);
        void tracked.wait().finally(() => processes.delete(tracked));
        if (revoked) void tracked.stopAndProve().catch(() => undefined);
        return tracked;
      };
      return {
        generation,
        attestation,
        status: {
          version: 1,
          actor: request.actor,
          state: "ready",
          backend: "zeros-srt",
          designProtection: {
            required: Boolean(request.territory),
            enforced: Boolean(request.territory),
            protectedDirectoryCount:
              request.territory?.protectedDesignDirectories.length ?? 0,
            ...(request.territory ? { territoryGeneration: generation } : {}),
          },
          parity: {
            level: restrictions.length === 0 ? "full" : "restricted",
            restrictions,
          },
          ...(request.containerWorker
            ? {
                services: {
                  state: "ready" as const,
                  activeCount: 1,
                  kinds: ["podman" as const],
                },
              }
            : {}),
          git: { state: "not-applicable" },
          checkedAt: Date.now(),
        },
        wrapSpawn: (spawnRequest: BoundarySpawnRequest) => {
          if (revoked) throw new Error("test boundary is revoked");
          return { ...spawnRequest, stdio: spawnRequest.stdio ?? "pipe" };
        },
        trackProcess,
        trackProcessGroup,
        spawn: async (spawnRequest) => {
          if (revoked) throw new Error("test boundary is revoked");
          return trackProcess(
            spawn(spawnRequest.command, spawnRequest.args, {
              cwd: spawnRequest.cwd,
              env: spawnRequest.env,
              detached: true,
              stdio:
                spawnRequest.stdio === "inherit"
                  ? "inherit"
                  : ["pipe", "pipe", "pipe"],
            }),
          );
        },
        requestPort: async (portRequest) => {
          if (revoked) throw new Error("test boundary is revoked");
          const lease: PortLease = {
            leaseId: `test-port-${randomUUID()}`,
            generation,
            host: "127.0.0.1",
            port: portRequest.preferredPort ?? 40_000,
            targetPort:
              portRequest.targetPort ?? portRequest.preferredPort ?? 40_000,
            revoke: async () => {
              leases.delete(lease);
              ports.delete(lease.leaseId);
              publishPorts();
            },
          };
          leases.add(lease);
          ports.set(lease.leaseId, {
            leaseId: lease.leaseId,
            generation,
            protocol: "tcp",
            host: lease.host,
            port: lease.port,
            targetPort: lease.targetPort,
            displayPort: portRequest.preferredPort ?? lease.targetPort,
            purpose: portRequest.purpose,
            source: "requested",
          });
          publishPorts();
          return lease;
        },
        activePorts: () => [...ports.values()],
        portDiscoveryStatus: () => ({
          state: revoked ? "revoked" : "idle",
        }),
        onPortsChanged: (listener) => {
          portObservers.add(listener);
          listener([...ports.values()]);
          return () => portObservers.delete(listener);
        },
        revoke: async () => {
          if (revoked) return;
          revoked = true;
          await Promise.all([...leases].map((lease) => lease.revoke()));
        },
        stopAndProve: async () => {
          revoked = true;
          await Promise.all([...leases].map((lease) => lease.revoke()));
          await Promise.all(
            [...processes].map((process) => process.stopAndProve()),
          );
          if (options.stopError) throw options.stopError;
          options.onStop?.(request);
        },
      };
    },
  };
}
