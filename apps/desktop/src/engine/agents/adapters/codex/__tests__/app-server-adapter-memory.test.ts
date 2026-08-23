import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const state = {
    config: {
      features: { memories: false },
      memories: { disable_on_external_context: false },
    } as Record<string, unknown>,
    version: "v1",
    goal: null as null | {
      threadId: string;
      objective: string;
      status: "active" | "paused";
      tokenBudget: number | null;
      tokensUsed: number;
      timeUsedSeconds: number;
      createdAt: number;
      updatedAt: number;
    },
    goalGetGate: null as Promise<void> | null,
    rateLimitReadGate: null as Promise<void> | null,
    rateLimitSnapshot: {
      limitId: null,
      limitName: null,
      primary: null,
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    } as Record<string, unknown>,
    effectiveMemoriesOverride: null as boolean | null,
    configWriteFailures: 0,
    notificationHandlers: new Map<string, (params: unknown) => void>(),
  };
  const requestTyped = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config/read") {
      const effectiveConfig =
        state.effectiveMemoriesOverride === null
          ? state.config
          : {
              ...state.config,
              features: { memories: state.effectiveMemoriesOverride },
            };
      return {
        config: effectiveConfig,
        origins: {},
        layers: [
          {
            name: {
              type: "user",
              file: "/tmp/codex/config.toml",
              profile: null,
            },
            version: state.version,
            config: state.config,
            disabledReason: null,
          },
        ],
      };
    }
    if (method === "config/batchWrite") {
      if (state.configWriteFailures > 0) {
        state.configWriteFailures -= 1;
        throw new Error("config version conflict");
      }
      const edits = (
        params as { edits: Array<{ keyPath: string; value: unknown }> }
      ).edits;
      for (const edit of edits) {
        if (edit.keyPath === "features.memories") {
          state.config = {
            ...state.config,
            features: { memories: edit.value },
          };
        }
        if (edit.keyPath === "memories.disable_on_external_context") {
          state.config = {
            ...state.config,
            memories: { disable_on_external_context: edit.value },
          };
        }
      }
      state.version = `v${Number(state.version.slice(1)) + 1}`;
      return {
        status: "ok",
        version: state.version,
        filePath: "/tmp/codex/config.toml",
        overriddenMetadata: null,
      };
    }
    if (method === "skills/list") return { data: [] };
    if (method === "thread/goal/get") {
      const snapshot = state.goal;
      if (state.goalGetGate) await state.goalGetGate;
      return { goal: snapshot };
    }
    if (method === "thread/goal/set") {
      const update = params as {
        threadId: string;
        objective?: string;
        status?: "active" | "paused";
        tokenBudget?: number | null;
      };
      state.goal = {
        threadId: update.threadId,
        objective: update.objective ?? state.goal?.objective ?? "",
        status: update.status ?? state.goal?.status ?? "active",
        tokenBudget:
          update.tokenBudget === undefined
            ? (state.goal?.tokenBudget ?? null)
            : update.tokenBudget,
        tokensUsed: state.goal?.tokensUsed ?? 0,
        timeUsedSeconds: state.goal?.timeUsedSeconds ?? 0,
        createdAt: state.goal?.createdAt ?? 1,
        updatedAt: 2,
      };
      return { goal: state.goal };
    }
    if (method === "thread/goal/clear") {
      state.goal = null;
      return { cleared: true };
    }
    if (method === "account/rateLimits/read") {
      const snapshot = state.rateLimitSnapshot;
      if (state.rateLimitReadGate) await state.rateLimitReadGate;
      return { rateLimits: snapshot };
    }
    return {};
  });
  return { state, requestTyped };
});

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: {
      userAgent: "codex_cli 0.149.0",
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "linux",
    },
    cliVersion: "0.149.0",
    binarySource: { source: "path", path: "codex" },
    child: { pid: 1234, killed: false },
    startThread: async () => ({
      threadId: "thread-memory",
      providerSessionId: "provider-session",
      model: "gpt-5",
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      raw: {},
    }),
    resumeThread: async (params: { threadId: string }) => ({
      threadId: params.threadId,
      providerSessionId: "provider-session",
      raw: {},
    }),
    runTurn: vi.fn(),
    runReview: vi.fn(),
    interruptTurn: vi.fn(async () => {}),
    respondToPermission: vi.fn(),
    respondToUserInput: vi.fn(),
    onNotification: vi.fn(
      (method: string, handler: (params: unknown) => void) => {
        native.state.notificationHandlers.set(method, handler);
        return () => native.state.notificationHandlers.delete(method);
      },
    ),
    onNotificationTyped: vi.fn(
      (method: string, handler: (params: unknown) => void) => {
        native.state.notificationHandlers.set(method, handler);
        return () => native.state.notificationHandlers.delete(method);
      },
    ),
    request: vi.fn(async () => ({})),
    requestTyped: native.requestTyped,
    dispose: vi.fn(async () => {}),
  })),
}));

vi.mock("../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/s",
    env: "/tmp/s/env",
    log: "/tmp/s/log",
    telemetry: "/tmp/s/tel",
  })),
  writeSessionMeta: vi.fn(async () => {}),
  removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

describe("Codex native memory capability", () => {
  beforeEach(() => {
    native.state.config = {
      features: { memories: false },
      memories: { disable_on_external_context: false },
    };
    native.state.version = "v1";
    native.state.goal = null;
    native.state.goalGetGate = null;
    native.state.rateLimitReadGate = null;
    native.state.rateLimitSnapshot = {
      limitId: null,
      limitName: null,
      primary: null,
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    };
    native.state.effectiveMemoriesOverride = null;
    native.state.configWriteFailures = 0;
    native.state.notificationHandlers.clear();
    native.requestTyped.mockClear();
  });

  const adapter = () =>
    new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate: vi.fn(),
        onPermissionRequest: vi.fn(),
        onQuestionRequest: vi.fn(),
        onAgentStderr: vi.fn(),
        onAgentExit: vi.fn(),
      },
    });

  it("reads global settings, writes native config with CAS, and syncs live threads", async () => {
    const instance = adapter();
    await instance.newSession({ cwd: "/tmp/proj" });
    const memory = instance.capabilityPorts.memory;
    expect(memory).toBeDefined();

    await expect(memory!.readSettings({ cwd: "/tmp/proj" })).resolves.toEqual({
      providerId: "codex",
      localMemoriesEnabled: false,
      toolAssistedGenerationEnabled: true,
      canReset: true,
    });

    await expect(
      memory!.updateSettings({
        cwd: "/tmp/proj",
        settings: {
          localMemoriesEnabled: true,
          toolAssistedGenerationEnabled: false,
        },
      }),
    ).resolves.toMatchObject({
      localMemoriesEnabled: true,
      toolAssistedGenerationEnabled: false,
    });

    expect(native.requestTyped).toHaveBeenCalledWith(
      "config/batchWrite",
      expect.objectContaining({
        expectedVersion: "v1",
        reloadUserConfig: true,
        edits: [
          {
            keyPath: "features.memories",
            value: true,
            mergeStrategy: "upsert",
          },
          {
            keyPath: "memories.disable_on_external_context",
            value: true,
            mergeStrategy: "upsert",
          },
        ],
      }),
    );
    expect(native.requestTyped).toHaveBeenCalledWith("thread/memoryMode/set", {
      threadId: "thread-memory",
      mode: "enabled",
    });
    await instance.dispose();
  });

  it("resets native memory through the dedicated app-server method", async () => {
    const instance = adapter();
    const memory = instance.capabilityPorts.memory;
    await expect(memory!.reset({ cwd: "/tmp/proj" })).resolves.toBeUndefined();
    expect(native.requestTyped).toHaveBeenCalledWith("memory/reset", undefined);
    await instance.dispose();
  });

  it("re-reads and retries one idempotent memory write after a CAS conflict", async () => {
    native.state.configWriteFailures = 1;
    const instance = adapter();
    await expect(
      instance.capabilityPorts.memory.updateSettings({
        cwd: "/tmp/proj",
        settings: { localMemoriesEnabled: true },
      }),
    ).resolves.toMatchObject({ localMemoriesEnabled: true });
    expect(
      native.requestTyped.mock.calls.filter(
        ([method]) => method === "config/batchWrite",
      ),
    ).toHaveLength(2);
    await instance.dispose();
  });

  it("syncs live threads to the effective managed memory policy", async () => {
    const instance = adapter();
    await instance.newSession({ cwd: "/tmp/proj" });
    native.requestTyped.mockClear();
    native.state.effectiveMemoriesOverride = false;

    await expect(
      instance.capabilityPorts.memory.updateSettings({
        cwd: "/tmp/proj",
        settings: { localMemoriesEnabled: true },
      }),
    ).resolves.toMatchObject({ localMemoriesEnabled: false });

    expect(native.requestTyped).toHaveBeenCalledWith("thread/memoryMode/set", {
      threadId: "thread-memory",
      mode: "disabled",
    });
    await instance.dispose();
  });

  it("projects the native goal lifecycle through the narrow goal port", async () => {
    const instance = adapter();
    const created = await instance.newSession({ cwd: "/tmp/proj" });
    const goal = instance.capabilityPorts.goal;

    await expect(
      goal.set({
        sessionId: created.session.executionId,
        update: { objective: "Ship Phase 3" },
      }),
    ).resolves.toMatchObject({
      objective: "Ship Phase 3",
      status: "active",
      tokenBudget: null,
    });
    await expect(
      goal.get({ sessionId: created.session.executionId }),
    ).resolves.toMatchObject({ objective: "Ship Phase 3" });
    await expect(
      goal.set({
        sessionId: created.session.executionId,
        update: { status: "paused" },
      }),
    ).resolves.toMatchObject({ status: "paused" });
    await expect(
      goal.clear({ sessionId: created.session.executionId }),
    ).resolves.toBeUndefined();
    await expect(
      goal.get({ sessionId: created.session.executionId }),
    ).resolves.toBeNull();

    expect(native.requestTyped).toHaveBeenCalledWith("thread/goal/clear", {
      threadId: "thread-memory",
    });
    await instance.dispose();
  });

  it("does not let a stale initial goal read overwrite a newer goal mutation", async () => {
    let releaseGoalRead!: () => void;
    native.state.goalGetGate = new Promise<void>((resolve) => {
      releaseGoalRead = resolve;
    });
    const onSessionUpdate = vi.fn();
    const instance = new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate,
        onPermissionRequest: vi.fn(),
        onQuestionRequest: vi.fn(),
        onAgentStderr: vi.fn(),
        onAgentExit: vi.fn(),
      },
    });
    const created = await instance.newSession({ cwd: "/tmp/proj" });
    await instance.capabilityPorts.goal.set({
      sessionId: created.session.executionId,
      update: { objective: "Newer goal" },
    });
    onSessionUpdate.mockClear();
    releaseGoalRead();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      onSessionUpdate.mock.calls.some(([, notification]) =>
        JSON.stringify(notification).includes('"sessionUpdate":"goal_update"'),
      ),
    ).toBe(false);
    await instance.dispose();
  });

  it("clears account-scoped quota immediately when Codex signs out", async () => {
    const onProviderQuotaUpdated = vi.fn();
    const instance = new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate: vi.fn(),
        onPermissionRequest: vi.fn(),
        onQuestionRequest: vi.fn(),
        onAgentStderr: vi.fn(),
        onAgentExit: vi.fn(),
        onProviderQuotaUpdated,
      },
    });
    await instance.newSession({ cwd: "/tmp/proj" });
    native.state.notificationHandlers.get("account/updated")?.({
      authMode: "chatgpt",
      planType: "plus",
    });
    native.state.notificationHandlers.get("account/rateLimits/updated")?.({
      rateLimits: {
        primary: {
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: 10_000,
        },
      },
    });
    expect(onProviderQuotaUpdated).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({ providerId: "codex" }),
    );

    native.state.notificationHandlers.get("account/updated")?.({
      authMode: null,
      planType: null,
    });
    expect(onProviderQuotaUpdated).toHaveBeenLastCalledWith("codex", null);
    const callsAfterLogout = onProviderQuotaUpdated.mock.calls.length;
    native.state.notificationHandlers.get("account/rateLimits/updated")?.({
      rateLimits: {
        primary: {
          usedPercent: 99,
          windowDurationMins: 300,
          resetsAt: 20_000,
        },
      },
    });
    expect(onProviderQuotaUpdated).toHaveBeenCalledTimes(callsAfterLogout);
    expect(onProviderQuotaUpdated).toHaveBeenLastCalledWith("codex", null);
    await instance.dispose();
  });

  it("does not merge an in-flight pre-logout quota read into the next account", async () => {
    let releaseRateLimitRead!: () => void;
    native.state.rateLimitReadGate = new Promise<void>((resolve) => {
      releaseRateLimitRead = resolve;
    });
    native.state.rateLimitSnapshot = {
      limitId: "account-a",
      limitName: "Account A",
      primary: null,
      secondary: {
        usedPercent: 80,
        windowDurationMins: 10_080,
        resetsAt: 20_000,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "12.34",
      },
      individualLimit: null,
      spendControlReached: null,
      planType: "plus",
      rateLimitReachedType: null,
    };
    const onProviderQuotaUpdated = vi.fn();
    const instance = new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate: vi.fn(),
        onPermissionRequest: vi.fn(),
        onQuestionRequest: vi.fn(),
        onAgentStderr: vi.fn(),
        onAgentExit: vi.fn(),
        onProviderQuotaUpdated,
      },
    });
    await instance.newSession({ cwd: "/tmp/proj" });
    // The signed-out update can beat the runtime's initial signed-in snapshot.
    // It must still invalidate the already-running Account A read; Account B
    // may log in before that old request finally resolves.
    native.state.notificationHandlers.get("account/updated")?.({
      authMode: null,
      planType: null,
    });
    native.state.notificationHandlers.get("account/updated")?.({
      authMode: "chatgpt",
      planType: "team",
    });
    releaseRateLimitRead();
    await new Promise((resolve) => setTimeout(resolve, 0));

    native.state.notificationHandlers.get("account/rateLimits/updated")?.({
      rateLimits: {
        primary: {
          usedPercent: 5,
          windowDurationMins: 300,
          resetsAt: 30_000,
        },
      },
    });

    expect(onProviderQuotaUpdated).toHaveBeenLastCalledWith(
      "codex",
      expect.not.objectContaining({
        secondary: expect.anything(),
        credits: expect.anything(),
        plan: "plus",
      }),
    );
    await instance.dispose();
  });

  it("keeps denied action bytes engine-only and retries once by opaque id", async () => {
    const onSessionUpdate = vi.fn();
    const instance = new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate,
        onPermissionRequest: vi.fn(),
        onQuestionRequest: vi.fn(),
        onAgentStderr: vi.fn(),
        onAgentExit: vi.fn(),
      },
    });
    const created = await instance.newSession({ cwd: "/tmp/proj" });
    onSessionUpdate.mockClear();
    native.state.notificationHandlers.get("thread/environment/connected")?.({
      threadId: "child-thread",
      environmentId: "private-child-environment",
    });
    native.state.notificationHandlers.get("model/rerouted")?.({
      threadId: "child-thread",
      turnId: "child-turn",
      fromModel: "child-a",
      toModel: "child-b",
      reason: "highRiskCyberActivity",
    });
    native.state.notificationHandlers.get("item/mcpToolCall/progress")?.({
      threadId: "child-thread",
      turnId: "child-turn",
      itemId: "child-mcp",
      message: "private child progress",
    });
    native.state.notificationHandlers.get("item/autoApprovalReview/started")?.({
      threadId: "child-thread",
      reviewId: "child-review",
    });
    native.state.notificationHandlers.get(
      "item/autoApprovalReview/completed",
    )?.({
      threadId: "child-thread",
      reviewId: "child-review",
      decisionSource: "agent",
      review: { status: "denied" },
      action: { type: "command", command: "child-secret" },
    });
    expect(onSessionUpdate).not.toHaveBeenCalled();

    const completed = native.state.notificationHandlers.get(
      "item/autoApprovalReview/completed",
    );
    expect(completed).toBeTypeOf("function");
    const deniedEvent = {
      threadId: "thread-memory",
      turnId: "turn-1",
      reviewId: "review-1",
      startedAtMs: 1,
      completedAtMs: 2,
      targetItemId: "item-1",
      decisionSource: "agent",
      review: {
        status: "denied",
        riskLevel: "high",
        userAuthorization: null,
        rationale: "Requires explicit approval",
      },
      action: {
        type: "command",
        source: "model",
        command: "secret-command --token hidden",
        cwd: "/private/worktree",
      },
    };
    completed!(deniedEvent);
    completed!(deniedEvent);

    const serialized = JSON.stringify(onSessionUpdate.mock.calls);
    expect(serialized).toContain("Requires explicit approval");
    expect(serialized).not.toContain("secret-command");
    expect(serialized).not.toContain("/private/worktree");
    const retryId = (
      onSessionUpdate.mock.calls
        .flatMap((call) => call)
        .find(
          (value) =>
            value &&
            typeof value === "object" &&
            JSON.stringify(value).includes("safety_review_retry_available"),
        ) as {
        update?: { retryId?: string };
      }
    )?.update?.retryId;
    expect(retryId).toMatch(/^[0-9a-f-]+$/i);
    expect(
      onSessionUpdate.mock.calls.filter(([, notification]) => {
        const update = (notification as { update?: Record<string, unknown> })
          .update;
        return (
          update?.sessionUpdate === "safety_review_retry_available" &&
          typeof update.retryId === "string"
        );
      }),
    ).toHaveLength(1);

    await instance.capabilityPorts.safety.retryDeniedAction({
      sessionId: created.session.executionId,
      retryId: retryId!,
    });
    expect(native.requestTyped).toHaveBeenCalledWith(
      "thread/approveGuardianDeniedAction",
      expect.objectContaining({
        threadId: "thread-memory",
        event: expect.objectContaining({ reviewId: "review-1" }),
      }),
    );
    await expect(
      instance.capabilityPorts.safety.retryDeniedAction({
        sessionId: created.session.executionId,
        retryId: retryId!,
      }),
    ).rejects.toThrow(/no longer available/i);
    await instance.dispose();
  });

  it("bounds denied-action authority and revokes the oldest live affordance", async () => {
    const onSessionUpdate = vi.fn();
    const instance = new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate,
        onPermissionRequest: vi.fn(),
        onQuestionRequest: vi.fn(),
        onAgentStderr: vi.fn(),
        onAgentExit: vi.fn(),
      },
    });
    const created = await instance.newSession({ cwd: "/tmp/proj" });
    onSessionUpdate.mockClear();
    const completed = native.state.notificationHandlers.get(
      "item/autoApprovalReview/completed",
    );
    expect(completed).toBeTypeOf("function");
    for (let index = 0; index < 11; index += 1) {
      completed!({
        threadId: "thread-memory",
        turnId: `turn-${index}`,
        reviewId: `review-${index}`,
        startedAtMs: index,
        completedAtMs: index + 1,
        targetItemId: `item-${index}`,
        decisionSource: "agent",
        review: {
          status: "denied",
          riskLevel: "high",
          userAuthorization: null,
          rationale: "Requires approval",
        },
        action: {
          type: "command",
          source: "model",
          command: `command-${index}`,
          cwd: "/private/worktree",
        },
      });
    }
    const retryUpdates = onSessionUpdate.mock.calls
      .map(
        ([, notification]) =>
          notification as { update?: Record<string, unknown> },
      )
      .filter(
        (notification) =>
          notification.update?.sessionUpdate ===
          "safety_review_retry_available",
      );
    const available = retryUpdates
      .map((notification) => notification.update?.retryId)
      .filter((value): value is string => typeof value === "string");
    expect(available).toHaveLength(11);
    expect(
      retryUpdates.some(
        (notification) => notification.update?.retryId === null,
      ),
    ).toBe(true);

    await expect(
      instance.capabilityPorts.safety.retryDeniedAction({
        sessionId: created.session.executionId,
        retryId: available[0],
      }),
    ).rejects.toThrow(/no longer available/i);
    await expect(
      instance.capabilityPorts.safety.retryDeniedAction({
        sessionId: created.session.executionId,
        retryId: available.at(-1)!,
      }),
    ).resolves.toBeUndefined();
    await instance.dispose();
  });

  it("does not evict a retained retry when a denial is replayed at capacity", async () => {
    const onSessionUpdate = vi.fn();
    const instance = new CodexAppServerAdapter({
      projectRoot: "/tmp/proj",
      mcpServers: [],
      sessionDirRoot: "/tmp/sessions",
      emit: {
        onSessionUpdate,
        onPermissionRequest: vi.fn(),
        onQuestionRequest: vi.fn(),
        onAgentStderr: vi.fn(),
        onAgentExit: vi.fn(),
      },
    });
    const created = await instance.newSession({ cwd: "/tmp/proj" });
    onSessionUpdate.mockClear();
    const completed = native.state.notificationHandlers.get(
      "item/autoApprovalReview/completed",
    );
    expect(completed).toBeTypeOf("function");

    const events = Array.from({ length: 10 }, (_, index) => ({
      threadId: "thread-memory",
      turnId: `turn-${index}`,
      reviewId: `review-${index}`,
      startedAtMs: index,
      completedAtMs: index + 1,
      targetItemId: `item-${index}`,
      decisionSource: "agent",
      review: {
        status: "denied",
        riskLevel: "high",
        userAuthorization: null,
        rationale: "Requires approval",
      },
      action: {
        type: "command",
        source: "model",
        command: `command-${index}`,
        cwd: "/private/worktree",
      },
    }));
    for (const event of events) completed!(event);
    const oldestRetryId = onSessionUpdate.mock.calls
      .map(
        ([, notification]) =>
          notification as { update?: Record<string, unknown> },
      )
      .map((notification) => notification.update)
      .find(
        (update) =>
          update?.sessionUpdate === "safety_review_retry_available" &&
          typeof update.retryId === "string",
      )?.retryId as string;
    expect(oldestRetryId).toMatch(/^[0-9a-f-]+$/i);

    onSessionUpdate.mockClear();
    completed!(events.at(-1)!);
    expect(onSessionUpdate).not.toHaveBeenCalled();
    await expect(
      instance.capabilityPorts.safety.retryDeniedAction({
        sessionId: created.session.executionId,
        retryId: oldestRetryId,
      }),
    ).resolves.toBeUndefined();
    await instance.dispose();
  });
});
