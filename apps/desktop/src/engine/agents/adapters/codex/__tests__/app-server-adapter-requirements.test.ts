import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigRequirementsReadResponse } from "../generated/v2/ConfigRequirementsReadResponse";

const native = vi.hoisted(() => ({
  startThread: vi.fn(),
  runTurn: vi.fn(),
  request: vi.fn(),
  requirements: undefined as unknown,
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(async () => ({
    initializeResponse: { userAgent: "codex_cli 0.166.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" },
    cliVersion: "0.166.0", binarySource: { source: "path", path: "codex" },
    child: { pid: 1234, killed: false },
    startThread: native.startThread,
    runTurn: native.runTurn,
    interruptTurn: vi.fn(async () => {}),
    request: native.request,
    requestTyped: native.request,
    onNotification: () => () => {},
    dispose: vi.fn(async () => {}),
  })),
}));
vi.mock("../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({ root: "/tmp/s", env: "/tmp/s/env", log: "/tmp/s/log", telemetry: "/tmp/s/tel" })),
  writeSessionMeta: vi.fn(async () => {}), removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter } from "../app-server-adapter";

/** Exactly the generated `configRequirements/read` shape, with only the
 * approval and sandbox allow-lists varied. */
function managed(
  allowedApprovalPolicies: ("untrusted" | "on-request" | "never")[] | null,
  allowedSandboxModes: ("read-only" | "workspace-write" | "danger-full-access")[] | null,
): ConfigRequirementsReadResponse {
  const empty = Object.fromEntries([
    "modelProvider", "modelProviders", "allowedLoginMethods", "cliAuthCredentialsStore", "chatgptBaseUrl",
    "additionalDeveloperInstructions", "allowedApprovalsReviewers", "allowedWindowsSandboxImplementations",
    "allowedPermissionProfiles", "defaultPermissions", "allowedWebSearchModes", "allowManagedHooksOnly",
    "allowBrowserAndComputerUse", "allowAppshots", "allowRemoteControl", "computerUse", "browserUse", "inAppBrowser",
    "featureRequirements", "hooks", "enforceResidency", "network", "application", "autoReview", "models", "sqliteHome",
    "logDir", "modelCatalogJson", "checkForUpdateOnStartup", "allowLoginShell", "feedback", "otel",
  ].map((key) => [key, null]));
  return {
    supportsIndependentSpeedModes: true,
    requirements: { ...empty, allowedApprovalPolicies, allowedSandboxModes } as ConfigRequirementsReadResponse["requirements"],
  };
}

const adapters: CodexAppServerAdapter[] = [];
const emitted: unknown[] = [];

beforeEach(() => {
  emitted.length = 0;
  native.requirements = { supportsIndependentSpeedModes: true, requirements: null };
  native.startThread.mockReset().mockResolvedValue({ threadId: "thread-managed", model: "gpt-6.1-sol", raw: {} });
  native.runTurn.mockReset().mockResolvedValue({ turnId: "turn-1", status: "completed", raw: {} });
  native.request.mockReset().mockImplementation(async (method: string) => {
    if (method === "configRequirements/read") {
      if (native.requirements instanceof Error) throw native.requirements;
      return native.requirements;
    }
    if (method === "config/read") return { config: {} };
    if (method === "skills/list" || method === "model/list") return { data: [] };
    return {};
  });
});
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose())); });

function adapter() {
  const created = new CodexAppServerAdapter({
    projectRoot: "/tmp/proj", mcpServers: [], sessionDirRoot: "/tmp/sessions",
    emit: {
      onSessionUpdate: (_agentId, notification) => { emitted.push(notification); },
      onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn(),
    },
  });
  adapters.push(created);
  return created;
}
const env = (mode: string) => ({ OPENAI_MODEL: "gpt-6.1-sol", ZEROS_PERMISSION_MODE: mode });
const threadStart = () => native.startThread.mock.calls.at(-1)?.[0];
const turnStart = () => native.runTurn.mock.calls.at(-1)?.[0];

describe("Codex managed requirements", () => {
  it("never sends an approval policy the managed configuration disallows", async () => {
    native.requirements = managed(["on-request"], null);
    const { session } = await adapter().newSession({ cwd: "/tmp/proj", env: env("ask") });

    expect(threadStart()).toMatchObject({ approvalPolicy: "on-request" });
    expect(session.modes?.currentModeId).toBe("read-only");
    expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual(["auto-edit", "read-only"]);
  });

  it("falls back from a disallowed sandbox to the nearest more restrictive mode on thread and turn", async () => {
    native.requirements = managed(null, ["read-only", "workspace-write"]);
    const codex = adapter();
    const { session } = await codex.newSession({ cwd: "/tmp/proj", env: env("full-access") });

    expect(threadStart()).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(session.modes?.currentModeId).toBe("auto-edit");
    expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual(["ask", "auto-edit", "read-only"]);

    await codex.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Work" }] });
    expect(turnStart()).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });
  });

  it("refuses an explicit switch to a mode the organization policy blocks", async () => {
    native.requirements = managed(["untrusted", "on-request"], ["read-only", "workspace-write"]);
    const codex = adapter();
    const { session } = await codex.newSession({ cwd: "/tmp/proj", env: env("auto-edit") });

    await expect(codex.setMode({ sessionId: session.sessionId, modeId: "full-access" }))
      .rejects.toThrow(/organization's Codex policy/);
    await codex.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Work" }] });
    expect(turnStart()).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });
  });

  it("fails with the organization policy, not a configuration error, when no mode is allowed", async () => {
    native.requirements = managed(["never"], ["read-only", "workspace-write"]);
    await expect(adapter().newSession({ cwd: "/tmp/proj", env: env("ask") }))
      .rejects.toThrow(/organization's Codex policy allows none of Zeros' permission modes/);
    expect(native.startThread).not.toHaveBeenCalled();
  });

  it.each([
    ["the method is unavailable", new Error("Invalid request: unknown variant `configRequirements/read`")],
    ["no requirements are configured", { supportsIndependentSpeedModes: null, requirements: null }],
  ])("keeps every mode unrestricted when %s", async (_case, requirements) => {
    native.requirements = requirements;
    const { session } = await adapter().newSession({ cwd: "/tmp/proj", env: env("ask") });

    expect(threadStart()).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(session.modes?.currentModeId).toBe("ask");
    expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual(["ask", "auto-edit", "full-access", "read-only"]);
  });
});
