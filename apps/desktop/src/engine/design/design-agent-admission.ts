import type { ExecutionBoundaryActor } from "@zeros/protocol/containment";

import type { McpServerRegistration } from "../agents/types";
import {
  type CreateDesignAgentCapabilityInput,
  type DesignAgentCapabilityGrant,
  DesignAgentCapabilityManager,
} from "./design-agent-capability";
import {
  DESIGN_AGENT_CAPABILITY_ENV,
  DesignAgentMcpServer,
} from "./design-agent-mcp";

type DesignAgentHttpRegistration = Extract<
  McpServerRegistration,
  { transport: "http" }
>;

interface DesignAgentToolServer {
  readonly registration: DesignAgentHttpRegistration;
  readonly localPort: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DesignAgentAdmission {
  readonly actor: Extract<ExecutionBoundaryActor, "design-agent">;
  readonly agentRunId: string;
  /** Passed only to the provider process. The opaque value must not be copied
   * into argv, logs, persisted session metadata, or MCP registrations. */
  readonly env: Readonly<Record<typeof DESIGN_AGENT_CAPABILITY_ENV, string>>;
  readonly mcpServers: readonly DesignAgentHttpRegistration[];
  /** Exact loopback ingress that ZSR may reopen for this run. */
  readonly trustedLocalPorts: readonly number[];
}

interface LiveAdmission {
  readonly capability: DesignAgentCapabilityGrant;
  readonly server: DesignAgentToolServer;
  readonly public: DesignAgentAdmission;
  ttlMs: number;
  renewalTimer?: ReturnType<typeof setTimeout>;
}

/** Trusted orchestrator for the authority that lives as long as one Design
 * agent session. Starting it does not start a VM or clone a worktree: it mints
 * one scoped capability and binds one ephemeral loopback MCP endpoint. */
export class DesignAgentAdmissionManager {
  private readonly capabilities: DesignAgentCapabilityManager;
  private readonly serverFactory: (input: {
    manager: DesignAgentCapabilityManager;
    token: string;
  }) => DesignAgentToolServer;
  private readonly runs = new Map<string, LiveAdmission>();
  private readonly starting = new Set<string>();

  constructor(
    options: {
      capabilities?: DesignAgentCapabilityManager;
      serverFactory?: (input: {
        manager: DesignAgentCapabilityManager;
        token: string;
      }) => DesignAgentToolServer;
    } = {},
  ) {
    this.capabilities =
      options.capabilities ?? new DesignAgentCapabilityManager();
    this.serverFactory =
      options.serverFactory ??
      ((input) => new DesignAgentMcpServer(input));
  }

  async start(
    input: CreateDesignAgentCapabilityInput,
  ): Promise<DesignAgentAdmission> {
    if (this.runs.has(input.agentRunId) || this.starting.has(input.agentRunId)) {
      throw new Error("This Design-agent run is already active.");
    }
    this.starting.add(input.agentRunId);
    let capability: DesignAgentCapabilityGrant | null = null;
    let server: DesignAgentToolServer | null = null;
    try {
      capability = await this.capabilities.create(input);
      server = this.serverFactory({
        manager: this.capabilities,
        token: capability.token,
      });
      await server.start();
      const registration = server.registration;
      const admitted: DesignAgentAdmission = Object.freeze({
        actor: "design-agent" as const,
        agentRunId: capability.agentRunId,
        env: Object.freeze({
          [DESIGN_AGENT_CAPABILITY_ENV]: `Bearer ${capability.token}`,
        }),
        mcpServers: Object.freeze([Object.freeze({ ...registration })]),
        trustedLocalPorts: Object.freeze([server.localPort]),
      });
      this.runs.set(capability.agentRunId, {
        capability,
        server,
        public: admitted,
        ttlMs: capability.expiresAt - capability.issuedAt,
      });
      this.scheduleRenewal(capability.agentRunId);
      return admitted;
    } catch (error) {
      if (server) await server.stop().catch(() => undefined);
      if (capability) this.capabilities.revoke(capability.token);
      throw error;
    } finally {
      this.starting.delete(input.agentRunId);
    }
  }

  renew(agentRunId: string, ttlMs?: number): DesignAgentCapabilityGrant {
    const run = this.runs.get(agentRunId);
    if (!run) throw new Error("This Design-agent run is not active.");
    const renewed = this.capabilities.renew(run.capability.token, ttlMs);
    if (ttlMs !== undefined) run.ttlMs = ttlMs;
    this.scheduleRenewal(agentRunId);
    return renewed;
  }

  async stop(agentRunId: string): Promise<boolean> {
    const run = this.runs.get(agentRunId);
    if (!run) return false;
    this.runs.delete(agentRunId);
    if (run.renewalTimer) clearTimeout(run.renewalTimer);
    try {
      await run.server.stop();
    } finally {
      this.capabilities.revoke(run.capability.token);
    }
    return true;
  }

  async stopAll(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...this.runs.keys()].map((agentRunId) => this.stop(agentRunId)),
    );
    const failures = outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      )
      .map((outcome) => outcome.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Design-agent admissions could not be retired.",
      );
    }
  }

  activeCount(): number {
    return this.runs.size;
  }

  /** Keep a live provider session usable without minting a new bearer for
   * every prompt. The timer is orchestration state only (unref'd, never
   * persisted); explicit stop/revocation remains the authority boundary. */
  private scheduleRenewal(agentRunId: string): void {
    const run = this.runs.get(agentRunId);
    if (!run) return;
    if (run.renewalTimer) clearTimeout(run.renewalTimer);
    run.renewalTimer = setTimeout(
      () => {
        const current = this.runs.get(agentRunId);
        if (current !== run) return;
        try {
          this.capabilities.renew(run.capability.token, run.ttlMs);
          this.scheduleRenewal(agentRunId);
        } catch {
          // A suspended process can wake after the capability has already
          // expired. Never resurrect that bearer; retire the admission so the
          // owning session can be rebuilt through normal trusted admission.
          void this.stop(agentRunId).catch(() => undefined);
        }
      },
      Math.max(1, Math.floor(run.ttlMs / 2)),
    );
    run.renewalTimer.unref?.();
  }
}
