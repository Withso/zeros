import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentials from "../provider-credentials";
import * as providerEnv from "../../settings/provider-env";
import { AgentGateway } from "../gateway";
import { classifyCursorSdkError } from "../adapters/cursor-sdk/adapter";
import type { AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const message = [{ type: "text" as const, text: "Continue" }];
const completed = {
  stopReason: "end_turn" as const,
  response: { stopReason: "end_turn" as const },
};

function setup() {
  let selectedKey = "original-fixture-key";
  vi.spyOn(credentials, "providerAccountProfile").mockReturnValue(null);
  vi.spyOn(providerEnv, "usesProviderApiKey").mockReturnValue(true);
  vi.spyOn(providerEnv, "applyUserProviderConfig").mockImplementation(
    (_cwd, _agent, base) => ({
      ...base,
      env: { ...base.env, CURSOR_API_KEY: selectedKey },
    }),
  );
  const gateway = new AgentGateway({
    projectRoot: "/tmp/cursor-credential-fixture",
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
  const prompt = vi.fn<AgentAdapter["prompt"]>().mockResolvedValue(completed);
  const disposeSession = vi.fn(async () => {});
  const internal = gateway as unknown as {
    adapters: Map<string, AgentAdapter>;
    executionToAgent: Map<string, string>;
    executionAuthFingerprint: Map<string, string>;
    providerAuthConfigFingerprint: (id: string) => string;
    runtimeAuthFailed: Map<string, unknown>;
  };
  internal.adapters.set("cursor", {
    agentId: "cursor",
    prompt,
    disposeSession,
    dispose: async () => {},
  } as unknown as AgentAdapter);
  internal.executionToAgent.set("execution", "cursor");
  internal.executionAuthFingerprint.set(
    "execution",
    internal.providerAuthConfigFingerprint("cursor"),
  );
  return {
    gateway,
    internal,
    prompt,
    disposeSession,
    replaceCredential: () => {
      selectedKey = "replacement-fixture-key";
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Cursor credentials across active gateway turns", () => {
  it("does not invalidate replacement credentials when the old run reports revoked access", async () => {
    const c = setup();
    let reject!: (error: Error) => void;
    c.prompt.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const pending = c.gateway.prompt("cursor", "execution", message);
    const failure = classifyCursorSdkError(
      { code: "unauthenticated", message: "The old credential was revoked." },
      "prompt",
    );
    const rejected = expect(pending).rejects.toBe(failure);
    try {
      await vi.waitFor(() => expect(c.prompt).toHaveBeenCalledOnce());
      c.replaceCredential();
      reject(failure);
      await rejected;
      expect(c.internal.runtimeAuthFailed.has("cursor")).toBe(false);
      // A subsequent send must reconnect before dispatching under the new key.
      await expect(
        c.gateway.prompt("cursor", "execution", message),
      ).rejects.toMatchObject({
        failure: { kind: "session-expired" },
      });
      expect(c.prompt).toHaveBeenCalledOnce();
      expect(c.disposeSession).toHaveBeenCalledWith("execution");
      expect(c.internal.executionToAgent.has("execution")).toBe(false);
    } finally {
      reject(failure);
      await pending.catch(() => {});
      await c.gateway.dispose();
    }
  });

  it("does not let an old run clear the current credential's authentication failure", async () => {
    const c = setup();
    let resolve!: (value: typeof completed) => void;
    c.prompt.mockReturnValueOnce(
      new Promise((finish) => {
        resolve = finish;
      }),
    );
    const pending = c.gateway.prompt("cursor", "execution", message);
    try {
      await vi.waitFor(() => expect(c.prompt).toHaveBeenCalledOnce());
      c.replaceCredential();
      c.gateway.markAuthFailed("cursor");
      const currentFailure = c.internal.runtimeAuthFailed.get("cursor");
      resolve(completed);
      await expect(pending).resolves.toEqual(completed.response);
      expect(c.internal.runtimeAuthFailed.get("cursor")).toBe(currentFailure);
      expect(currentFailure).toBeDefined();
    } finally {
      resolve(completed);
      await pending.catch(() => {});
      await c.gateway.dispose();
    }
  });

  it.each(["expired", "disconnected"] as const)(
    "rejects a %s saved account before sending a prompt",
    async (state) => {
      const c = setup();
      vi.mocked(providerEnv.usesProviderApiKey).mockReturnValue(false);
      vi.mocked(credentials.providerAccountProfile).mockReturnValue({
        id: "00000000-0000-4000-8000-000000000000",
        state,
      });
      c.internal.executionAuthFingerprint.set(
        "execution",
        c.internal.providerAuthConfigFingerprint("cursor"),
      );
      try {
        await expect(
          c.gateway.prompt("cursor", "execution", message),
        ).rejects.toMatchObject({
          failure: { kind: "auth-required" },
        });
        expect(c.prompt).not.toHaveBeenCalled();
      } finally {
        await c.gateway.dispose();
      }
    },
  );
});
