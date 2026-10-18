import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentials from "../provider-credentials";
import * as providerEnv from "../../settings/provider-env";
import { AgentGateway } from "../gateway";
import * as cloudExecutions from "../cloud-provider-execution";
import { normalizeProviderError, providerErrorFailure } from "../adapters/shared/provider-error";
import { AgentFailureError, type AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

it("refuses an unconfigured account before contacting the provider", async () => {
  vi.spyOn(credentials, "providerAccountProfile").mockReturnValue({
    id: "00000000-0000-4000-8000-000000000000",
    state: "disconnected",
  });
  vi.spyOn(providerEnv, "usesProviderApiKey").mockReturnValue(false);
  const gateway = new AgentGateway({
    projectRoot: "/tmp/zeros-account-switch",
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
  const prompt = vi.fn(async () => ({ response: { stopReason: "end_turn" } }));
  const internals = gateway as unknown as {
    adapters: Map<string, AgentAdapter>;
    executionToAgent: Map<string, string>;
  };
  internals.adapters.set("claude", {
    agentId: "claude",
    prompt,
  } as unknown as AgentAdapter);
  internals.executionToAgent.set("no-account", "claude");
  try {
    await expect(
      gateway.prompt("claude", "no-account", [{ type: "text", text: "hi" }]),
    ).rejects.toMatchObject({ failure: { kind: "auth-required" } });
    expect(prompt).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

function localGateway() {
  return new AgentGateway({
    projectRoot: "/tmp/zeros-account-switch",
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
}

type SwitchInternals = {
  adapters: Map<string, AgentAdapter>;
  executionToAgent: Map<string, string>;
  executionToCwd: Map<string, string>;
  executionAuthFingerprint: Map<string, string>;
  runtimeAuthFailed: Map<string, { configFingerprint: string }>;
  providerAuthConfigFingerprint: (agentId: string) => string;
};

describe("Local provider connection changes", () => {
  afterEach(() => vi.restoreAllMocks());

  /** One live Claude execution admitted under saved account A. */
  function liveClaudeExecution() {
    const selection = { configDir: "/tmp/zeros-account-switch/account-a", revision: 1 };
    vi.spyOn(providerEnv, "usesProviderApiKey").mockReturnValue(false);
    vi.spyOn(credentials, "providerAccountProfile").mockImplementation(() => ({
      id: "00000000-0000-4000-8000-00000000000a",
      revision: selection.revision,
      state: "connected",
      configDir: selection.configDir,
    }));
    vi.spyOn(providerEnv, "applyUserProviderConfig").mockImplementation(
      (_cwd, _agentId, base) => ({
        ...base,
        env: {
          ...base.env,
          ANTHROPIC_API_KEY: "",
          CLAUDE_CONFIG_DIR: selection.configDir,
        },
      }),
    );
    const gateway = localGateway();
    const prompt = vi.fn(async () => ({ response: { stopReason: "end_turn" } }));
    const updateCredentials = vi.fn(async () => {});
    const disposeSession = vi.fn(async () => {});
    const cancel = vi.fn(async () => {});
    const listTools = vi.fn(async () => ({ state: "ready" as const, entries: [] }));
    const internals = gateway as unknown as SwitchInternals;
    internals.adapters.set("claude", {
      agentId: "claude",
      prompt,
      disposeSession,
      cancel,
      dispose: async () => {},
      capabilityPorts: {
        runtimeConfiguration: { updateCredentials },
        sessionTools: { list: listTools },
      },
    } as unknown as AgentAdapter);
    internals.executionToAgent.set("live", "claude");
    internals.executionToCwd.set("live", "/tmp/zeros-account-switch");
    internals.executionAuthFingerprint.set(
      "live",
      internals.providerAuthConfigFingerprint("claude"),
    );
    return { gateway, internals, selection, prompt, updateCredentials, disposeSession, listTools };
  }

  it("runs the next prompt under a newly selected account without a reconnect", async () => {
    const c = liveClaudeExecution();
    try {
      c.selection.configDir = "/tmp/zeros-account-switch/account-b";
      await expect(
        c.gateway.prompt("claude", "live", [{ type: "text", text: "next message" }]),
      ).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(c.updateCredentials).toHaveBeenCalledOnce();
      expect(c.updateCredentials).toHaveBeenCalledWith({
        sessionId: "live",
        keys: [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "CLAUDE_CONFIG_DIR",
        ],
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "",
          CLAUDE_CONFIG_DIR: "/tmp/zeros-account-switch/account-b",
        }),
        authenticationContext: c.internals.providerAuthConfigFingerprint("claude"),
      });
      // The adopted connection reaches the provider before this prompt does.
      expect(c.updateCredentials.mock.invocationCallOrder[0]).toBeLessThan(
        c.prompt.mock.invocationCallOrder[0]!,
      );
      expect(c.disposeSession).not.toHaveBeenCalled();
      expect(c.internals.executionToAgent.get("live")).toBe("claude");
      // The execution now owns the new connection: no repeated adoption.
      await c.gateway.prompt("claude", "live", [{ type: "text", text: "and again" }]);
      expect(c.updateCredentials).toHaveBeenCalledOnce();
      expect(c.prompt).toHaveBeenCalledTimes(2);
    } finally {
      await c.gateway.dispose();
    }
  });

  it("adopts a renewed login on the same account", async () => {
    const c = liveClaudeExecution();
    try {
      c.selection.revision = 2;
      await c.gateway.prompt("claude", "live", [{ type: "text", text: "hi" }]);
      expect(c.updateCredentials).toHaveBeenCalledOnce();
      expect(c.prompt).toHaveBeenCalledOnce();
    } finally {
      await c.gateway.dispose();
    }
  });

  it("applies the latest selection when Settings change again during adoption", async () => {
    const c = liveClaudeExecution();
    try {
      c.selection.configDir = "/tmp/zeros-account-switch/account-b";
      c.updateCredentials.mockImplementationOnce(async () => {
        c.selection.configDir = "/tmp/zeros-account-switch/account-c";
      });
      await c.gateway.prompt("claude", "live", [{ type: "text", text: "hi" }]);
      expect(c.updateCredentials).toHaveBeenCalledTimes(2);
      expect(c.updateCredentials).toHaveBeenLastCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CONFIG_DIR: "/tmp/zeros-account-switch/account-c",
          }),
        }),
      );
      expect(c.prompt).toHaveBeenCalledOnce();
    } finally {
      await c.gateway.dispose();
    }
  });

  it("joins one restart when a tool read races the next prompt", async () => {
    const c = liveClaudeExecution();
    try {
      c.selection.configDir = "/tmp/zeros-account-switch/account-b";
      let release!: () => void;
      c.updateCredentials.mockImplementationOnce(
        () => new Promise<void>((resolve) => { release = resolve; }),
      );
      // Account-scoped connectors are read under the new account too.
      const read = c.gateway.readSessionTools("claude", "live", "/tmp/zeros-account-switch");
      await vi.waitFor(() => expect(c.updateCredentials).toHaveBeenCalledOnce());
      const sent = c.gateway.prompt("claude", "live", [{ type: "text", text: "hi" }]);
      await Promise.resolve();
      expect(c.prompt).not.toHaveBeenCalled();
      release();
      await expect(read).resolves.toMatchObject({ state: "ready" });
      await expect(sent).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(c.updateCredentials).toHaveBeenCalledOnce();
      expect(c.updateCredentials.mock.invocationCallOrder[0]).toBeLessThan(
        c.listTools.mock.invocationCallOrder[0]!,
      );
    } finally {
      await c.gateway.dispose();
    }
  });

  it("honors Stop while a prompt waits for connection adoption", async () => {
    const c = liveClaudeExecution();
    let release!: () => void;
    c.updateCredentials.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    c.selection.configDir = "/tmp/zeros-account-switch/account-b";
    const sent = c.gateway.prompt("claude", "live", [{ type: "text", text: "stop this" }]);
    try {
      await vi.waitFor(() => expect(c.updateCredentials).toHaveBeenCalledOnce());
      await c.gateway.cancel("claude", "live");
      release();
      await expect(sent).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(c.prompt).not.toHaveBeenCalled();
      // A new user send can use the completed adoption.
      await c.gateway.prompt("claude", "live", [{ type: "text", text: "new send" }]);
      expect(c.prompt).toHaveBeenCalledOnce();
      expect(c.updateCredentials).toHaveBeenCalledOnce();
    } finally {
      release?.();
      await sent.catch(() => {});
      await c.gateway.dispose();
    }
  });

  it.each([
    { priorSuccess: false, superseded: false },
    { priorSuccess: false, superseded: true },
    { priorSuccess: true, superseded: false },
    { priorSuccess: true, superseded: true },
  ])("attributes an adoption rejection to its attempted connection: %j", async ({ priorSuccess, superseded }) => {
    const c = liveClaudeExecution();
    c.selection.configDir = "/tmp/zeros-account-switch/account-b";
    if (priorSuccess) c.updateCredentials.mockImplementationOnce(async () => {
      c.selection.configDir = "/tmp/zeros-account-switch/account-c";
    });
    let reject!: (error: Error) => void;
    c.updateCredentials.mockImplementationOnce(
      () => new Promise<void>((_, fail) => { reject = fail; }),
    );
    const pending = c.gateway.prompt("claude", "live", [{ type: "text", text: "next" }]);
    const failure = pending.catch((error) => error);
    try {
      await vi.waitFor(() => expect(c.updateCredentials).toHaveBeenCalledTimes(priorSuccess ? 2 : 1));
      const attempted = c.internals.providerAuthConfigFingerprint("claude");
      if (superseded) c.selection.configDir = "/tmp/zeros-account-switch/account-d";
      reject(new AgentFailureError({ kind: "auth-required", stage: "loadSession", message: "The attempted connection was rejected." }));
      await expect(failure).resolves.toMatchObject({ failure: { kind: "auth-required" } });
      expect(c.internals.runtimeAuthFailed.get("claude")).toEqual(
        superseded ? undefined : expect.objectContaining({ configFingerprint: attempted }),
      );
      expect(c.prompt).not.toHaveBeenCalled();
    } finally {
      await c.gateway.dispose();
    }
  });

  it("keeps the execution and asks for sign-in when the new account is disconnected", async () => {
    const c = liveClaudeExecution();
    try {
      vi.mocked(credentials.providerAccountProfile).mockReturnValue({
        id: "00000000-0000-4000-8000-00000000000b",
        state: "disconnected",
      });
      await expect(
        c.gateway.prompt("claude", "live", [{ type: "text", text: "hi" }]),
      ).rejects.toMatchObject({ failure: { kind: "auth-required" } });
      expect(c.prompt).not.toHaveBeenCalled();
      expect(c.updateCredentials).not.toHaveBeenCalled();
      expect(c.disposeSession).not.toHaveBeenCalled();
      expect(c.internals.executionToAgent.get("live")).toBe("claude");
    } finally {
      await c.gateway.dispose();
    }
  });

  it("never re-derives a cloud execution's admitted credential from Local settings", async () => {
    const boundary = {} as never;
    const validate = vi.fn(async () => {});
    const execution = {
      mode: "actor-grant-v1",
      provider: "claude",
      lease: { validate },
    } as unknown as cloudExecutions.CloudProviderExecution;
    const original = cloudExecutions.cloudProviderExecution;
    vi.spyOn(cloudExecutions, "cloudProviderExecution").mockImplementation(
      (value) => (value === boundary ? execution : original(value)),
    );
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-account-switch",
      executionBoundary: { ...testExecutionBoundary(), backend: "cloud-worker" },
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const prompt = vi.fn(async () => ({ response: { stopReason: "end_turn" } }));
    const updateCredentials = vi.fn(async () => {});
    const internals = gateway as unknown as SwitchInternals & {
      executionBoundaries: Map<string, unknown>;
    };
    internals.adapters.set("claude", {
      agentId: "claude",
      prompt,
      dispose: async () => {},
      capabilityPorts: { runtimeConfiguration: { updateCredentials } },
    } as unknown as AgentAdapter);
    internals.executionToAgent.set("cloud", "claude");
    internals.executionBoundaries.set("cloud", boundary);
    // The cloud admission's authority id never equals a Local fingerprint.
    internals.executionAuthFingerprint.set("cloud", "a".repeat(64));
    try {
      await gateway.prompt("claude", "cloud", [{ type: "text", text: "hi" }]);
      expect(validate).toHaveBeenCalledOnce();
      expect(updateCredentials).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      internals.executionBoundaries.clear();
      await gateway.dispose();
    }
  });

  it("retires an execution whose adapter cannot adopt a new connection", async () => {
    const gateway = localGateway();
    const prompt = vi.fn(async () => ({ response: { stopReason: "end_turn" } }));
    const disposeSession = vi.fn(async () => {});
    const internals = gateway as unknown as SwitchInternals;
    internals.adapters.set("claude", {
      agentId: "claude",
      prompt,
      disposeSession,
    } as unknown as AgentAdapter);
    internals.executionToAgent.set("old-account", "claude");
    internals.executionAuthFingerprint = new Map([
      ["old-account", "old-authentication"],
    ]);
    await expect(
      gateway.prompt("claude", "old-account", [
        { type: "text", text: "next message" },
      ]),
    ).rejects.toMatchObject({ failure: { kind: "session-expired" } });
    expect(prompt).not.toHaveBeenCalled();
    expect(disposeSession).toHaveBeenCalledWith("old-account");
    expect(internals.executionToAgent.has("old-account")).toBe(false);
  });
});

describe.each(["claude", "cursor", "codex"] as const)(
  "%s provider error health",
  (provider) => {
    afterEach(() => vi.restoreAllMocks());
    it.each([
      ["unauthenticated", true],
      ["rate_limit_exceeded", false],
      ["invalid_model", false],
      ["session_expired", false],
      ["ECONNRESET", false],
      ["unknown", false],
    ])(
      "invalidates credentials only for authentication evidence: %s",
      async (code, invalid) => {
        vi.spyOn(providerEnv, "usesProviderApiKey").mockReturnValue(true);
        const gateway = new AgentGateway({
          projectRoot: "/tmp/zeros-error-health",
          executionBoundary: testExecutionBoundary(),
          events: {
            onSessionUpdate: () => {},
            onPermissionRequest: () => {},
            onQuestionRequest: () => {},
            onAgentStderr: () => {},
            onAgentExit: () => {},
          },
        });
        const failure = providerErrorFailure(
          provider,
          normalizeProviderError(provider, {
            code,
            message:
              "Provider rejected this request. Check your API key settings.",
          }),
          "prompt",
        );
      const prompt = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ response: { stopReason: "cancelled" } })
        .mockResolvedValueOnce({ response: { stopReason: "end_turn" } });
        const internal = gateway as unknown as {
          adapters: Map<string, AgentAdapter>;
          executionToAgent: Map<string, string>;
          runtimeAuthFailed: Map<string, unknown>;
        };
        internal.adapters.set(provider, {
          agentId: provider,
          prompt,
          dispose: async () => {},
        } as unknown as AgentAdapter);
        internal.executionToAgent.set("execution", provider);
        try {
          await expect(
            gateway.prompt(provider, "execution", [
              { type: "text", text: "hi" },
            ]),
          ).rejects.toBe(failure);
        expect(internal.runtimeAuthFailed.has(provider)).toBe(invalid);
        await gateway.prompt(provider, "execution", [{ type: "text", text: "stopped before dispatch" }]);
        expect(internal.runtimeAuthFailed.has(provider)).toBe(invalid);
        await gateway.prompt(provider, "execution", [
            { type: "text", text: "retry" },
          ]);
          expect(internal.runtimeAuthFailed.has(provider)).toBe(false);
        } finally {
          await gateway.dispose();
        }
      },
    );
  },
);
