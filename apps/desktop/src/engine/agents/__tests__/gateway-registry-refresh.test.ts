import { describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";
import * as probes from "../probes";
import * as providerEnv from "../../settings/provider-env";
import * as credentials from "../provider-credentials";

describe("provider registry authentication refresh", () => {
  it.each(["claude", "codex"])(
    "recovers a migrated %s device account when its CLI credentials change",
    async (provider) => {
      vi.spyOn(probes, "probeCliInstalled").mockResolvedValue(
        new Set([provider]),
      );
      vi.spyOn(probes, "probeCliVersion").mockResolvedValue(null);
      vi.spyOn(probes, "evaluateAuthProbe").mockResolvedValue(true);
      vi.spyOn(providerEnv, "usesProviderApiKey").mockReturnValue(false);
      vi.spyOn(providerEnv, "applyUserProviderConfig").mockReturnValue({
        env: {},
      });
      vi.spyOn(credentials, "providerAccountProfile").mockImplementation(
        (id) =>
          id === provider
            ? { id: "00000000-0000-4000-8000-000000000001", state: "connected" }
            : null,
      );
      const modified = vi
        .spyOn(probes, "latestAuthFileMtimeMs")
        .mockResolvedValue(0);
      const gateway = new AgentGateway({
        projectRoot: "/tmp/zeros-registry-refresh",
        executionBoundary: testExecutionBoundary(),
        events: {
          onSessionUpdate: () => {},
          onPermissionRequest: () => {},
          onQuestionRequest: () => {},
          onAgentStderr: () => {},
          onAgentExit: () => {},
        },
      });
      const authenticated = async () =>
        (await gateway.refreshRegistry()).find((agent) => agent.id === provider)
          ?.authenticated;
      try {
        expect(await authenticated()).toBe(true);
        gateway.markAuthFailed(provider);
        expect(await authenticated()).toBe(false);
        modified.mockResolvedValue(Date.now() + 1_000);
        expect(await authenticated()).toBe(true);
      } finally {
        await gateway.dispose();
        vi.restoreAllMocks();
      }
    },
  );
  it("uses the selected account's confirmed status instead of another CLI account", async () => {
    vi.spyOn(probes, "probeCliInstalled").mockResolvedValue(
      new Set(["claude", "codex"]),
    );
    vi.spyOn(probes, "probeCliVersion").mockResolvedValue(null);
    vi.spyOn(probes, "evaluateAuthProbe").mockResolvedValue(true);
    vi.spyOn(providerEnv, "usesProviderApiKey").mockReturnValue(false);
    const profile = vi
      .spyOn(credentials, "providerAccountProfile")
      .mockReturnValue({
        id: "00000000-0000-4000-8000-000000000001",
        state: "disconnected",
        configDir: "/private/profile",
      });
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-registry-refresh",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    try {
      expect(
        (await gateway.refreshRegistry()).find((a) => a.id === "claude")
          ?.authenticated,
      ).toBe(false);
      profile.mockReturnValue({
        id: "00000000-0000-4000-8000-000000000001",
        state: "connected",
        configDir: "/private/profile",
      });
      expect(
        (await gateway.refreshRegistry()).find((a) => a.id === "claude")
          ?.authenticated,
      ).toBe(true);
      gateway.markAuthFailed("claude");
      vi.spyOn(probes, "latestAuthFileMtimeMs").mockResolvedValue(
        Date.now() + 1000,
      );
      // Another CLI account's credential file cannot revive this rejected account.
      expect(
        (await gateway.refreshRegistry()).find((a) => a.id === "claude")
          ?.authenticated,
      ).toBe(false);
    } finally {
      await gateway.dispose();
      vi.restoreAllMocks();
    }
  });
  it.each(["claude", "codex"])(
    "checks only the selected %s authentication method",
    async (provider) => {
      vi.spyOn(probes, "probeCliInstalled").mockResolvedValue(
        new Set(["claude", "codex"]),
      );
      vi.spyOn(probes, "probeCliVersion").mockResolvedValue(null);
      const cli = vi
        .spyOn(probes, "evaluateAuthProbe")
        .mockResolvedValue(false);
      const method = vi
        .spyOn(providerEnv, "usesProviderApiKey")
        .mockReturnValue(true);
      const keyVar =
        provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      const config = vi
        .spyOn(providerEnv, "applyUserProviderConfig")
        .mockReturnValue({ env: { [keyVar]: "fixture-key" } });
      const gateway = new AgentGateway({
        projectRoot: "/tmp/zeros-registry-refresh",
        executionBoundary: testExecutionBoundary(),
        events: {
          onSessionUpdate: () => {},
          onPermissionRequest: () => {},
          onQuestionRequest: () => {},
          onAgentStderr: () => {},
          onAgentExit: () => {},
        },
      });
      const connected = async () =>
        (await gateway.refreshRegistry()).find((agent) => agent.id === provider)
          ?.authenticated;
      try {
        expect(await connected()).toBe(true);
        config.mockReturnValue({ env: { [keyVar]: "" } });
        cli.mockResolvedValue(true);
        expect(await connected()).toBe(false);
        method.mockReturnValue(false);
        expect(await connected()).toBe(true);
        cli.mockResolvedValue(false);
        config.mockReturnValue({ env: { [keyVar]: "fixture-unused-key" } });
        expect(await connected()).toBe(false);
      } finally {
        await gateway.dispose();
        vi.restoreAllMocks();
      }
    },
  );
  it("keeps a runtime auth rejection through ordinary and forced refreshes until credentials change", async () => {
    vi.spyOn(probes, "probeCliInstalled").mockResolvedValue(new Set());
    vi.spyOn(probes, "probeCliVersion").mockResolvedValue(null);
    vi.spyOn(probes, "evaluateAuthProbe").mockResolvedValue(true);
    const modified = vi
      .spyOn(probes, "latestAuthFileMtimeMs")
      .mockResolvedValue(0);
    vi.spyOn(probes, "secretAccountFingerprint").mockResolvedValue(null);
    const config = vi
      .spyOn(providerEnv, "applyUserProviderConfig")
      .mockReturnValue({ env: {} });
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-registry-refresh",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const claude = async (force = false) =>
      (await (force ? gateway.refreshRegistry() : gateway.listAgents())).find(
        (agent) => agent.id === "claude",
      )?.authenticated;
    try {
      expect(await claude()).toBe(true);
      gateway.markAuthFailed("claude");
      expect(await claude()).toBe(false);
      expect(await claude(true)).toBe(false);
      expect(await claude(true)).toBe(false);
      modified.mockResolvedValue(Date.now() + 1_000);
      expect(await claude(true)).toBe(true);
      modified.mockResolvedValue(0);
      gateway.markAuthFailed("claude");
      expect(await claude(true)).toBe(false);
      gateway.markAuthOk("claude");
      expect(await claude()).toBe(true);
      gateway.markAuthFailed("claude");
      // Changing another provider must not revive Claude's rejected token.
      config.mockImplementation(
        (_cwd, id): providerEnv.ProviderSpawn => ({
          env: id === "cursor" ? { CURSOR_API_KEY: "fixture-new-key" } : {},
        }),
      );
      expect(await claude(true)).toBe(false);
      config.mockImplementation(
        (_cwd, id): providerEnv.ProviderSpawn => ({
          env: id === "claude" ? { ANTHROPIC_API_KEY: "fixture-new-key" } : {},
        }),
      );
      expect(await claude(true)).toBe(true);
    } finally {
      await gateway.dispose();
      vi.restoreAllMocks();
    }
  });
  it("keeps personal discovery outside directories cleaned by authentication probes", async () => {
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-registry-refresh",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const internal = gateway as unknown as {
      providerProbeRoot(owner: string): Promise<string>;
      runProviderOneShot(opts: { cwd: string }): Promise<string>;
    };
    vi.spyOn(internal, "providerProbeRoot").mockImplementation(
      async (owner) => `/tmp/${owner}`,
    );
    vi.spyOn(internal, "runProviderOneShot").mockImplementation(
      async (opts) => opts.cwd,
    );
    try {
      const authRoot = await internal.providerProbeRoot("codex");
      expect(await gateway.readExtensionInventory("codex", "apps")).not.toBe(
        authRoot,
      );
      expect(
        await gateway.readExtensionInventory("codex", "apps", "/repo"),
      ).toBe("/repo");
    } finally {
      await gateway.dispose();
    }
  });
  it("rechecks after an older probe finishes and shares the refreshed flight", async () => {
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-registry-refresh",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    type Agents = Awaited<ReturnType<AgentGateway["listAgents"]>>;
    const oldResult = [{ id: "cursor", authenticated: false }] as Agents;
    const newResult = [{ id: "cursor", authenticated: true }] as Agents;
    let finish!: (result: Agents) => void;
    const read = vi
      .spyOn(
        gateway as unknown as { listAgentsImpl(): Promise<Agents> },
        "listAgentsImpl",
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(newResult);
    try {
      const first = gateway.listAgents();
      const refresh = gateway.refreshRegistry();
      const alsoRefresh = gateway.refreshRegistry();
      finish(oldResult);
      await first;
      expect(await refresh).toBe(newResult);
      expect(await alsoRefresh).toBe(newResult);
      expect(await gateway.listAgents()).toBe(newResult);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await gateway.dispose();
    }
  });
});
