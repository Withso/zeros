import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSendFailureInput } from "../agent-send-failure-toast";

type Slot = { cwd: string; messages: { id: string }[]; cloudSendWait?: { state: string; turnId?: string } };
const mocks = vi.hoisted(() => ({ error: vi.fn(), log: vi.fn(), sessions: {} as Record<string, Slot> }));
vi.mock("../../../shared/ui/primitives/elements/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("../../../platform/observability/logging/renderer-log", () => ({ logEvent: mocks.log }));
vi.mock("../sessions-store", () => ({ useSessionsStore: { getState: () => ({ sessions: mocks.sessions }) } }));

const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
let notify: typeof import("../agent-send-failure-toast").notifyAgentSendFailure;
const input = (error: unknown, extra: Partial<AgentSendFailureInput> = {}): AgentSendFailureInput => ({
  folder, chatId: "chat", attemptId: "turn", agentId: "codex", model: "gpt-6.1-sol", error, ...extra,
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.sessions = {};
  notify = (await import("../agent-send-failure-toast")).notifyAgentSendFailure;
});

describe("agent send failure toasts", () => {
  it("records each explicit retry failure while preserving the original message identity", () => {
    const first = input(undefined, { reason: "history_unavailable", diagnosticAttemptId: "attempt-one" });
    notify(first); notify(first);
    notify({ ...first, diagnosticAttemptId: "attempt-two" });
    expect(mocks.log).toHaveBeenCalledTimes(2);
    expect(mocks.log.mock.calls.every(([event, detail]) => event === "agent_send_not_sent" &&
      JSON.stringify(detail) === JSON.stringify({ reason: "history_unavailable" }))).toBe(true);
  });

  it.each([
    ["command_conflict", "history_unavailable", "history_unavailable"],
    [undefined, "queued_timeout", "queued_timeout"],
    [undefined, "workspace_start_timeout", "workspace_start_timeout"],
    ["private detail", undefined, "unknown"],
  ] as const)("logs only a closed reason for %s/%s", (error, reason, expected) => {
    notify(input(error, { reason }));
    expect(mocks.log).toHaveBeenCalledExactlyOnceWith("agent_send_not_sent", { reason: expected }, ["cloud", "agent"]);
  });

  it.each(["/personal/project", "/organization/project"])("leaves %s failure logging unchanged", folder => {
    notify(input("private detail", { folder }));
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("keeps a failed queued send's Not sent card as its only surface", () => {
    mocks.sessions.chat = { cwd: folder, messages: [{ id: "queued" }], cloudSendWait: { state: "failed", turnId: "queued" } };
    expect(notify(input(undefined, { reason: "queued_timeout" }))).toBe(false);
    mocks.sessions.chat = { cwd: folder, messages: [] };
    expect(notify(input(undefined, { reason: "queued_timeout" }))).toBe(true);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent in time", expect.any(Object));
  });

  it("deduplicates by exact workspace, chat and turn/command identity, independent of cause", () => {
    const failed = input("first cause");
    notify(failed);
    mocks.error.mockClear(); // Dismissing a toast does not release the identity.
    expect(notify({ ...failed })).toBe(false);
    expect(notify({ ...failed, error: "second cause" })).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(notify({ ...failed, attemptId: "next-turn" })).toBe(true);
    expect(notify({ ...failed, chatId: "other-chat" })).toBe(true);
    expect(notify({ ...failed, folder: folder.replace("22222222", "44444444") })).toBe(true);
    expect(mocks.error).toHaveBeenCalledTimes(3);
  });

  it("maps a queued-send timeout through the same one-time surface", () => {
    const timeout = input(new Error("private diagnostic"), { reason: "queued_timeout" });
    expect(notify(timeout)).toBe(true);
    expect(notify({ ...timeout, reason: "workspace_unavailable" })).toBe(false);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent in time", expect.objectContaining({
      description: "Try sending again when the workspace is ready.",
    }));
  });

  it.each([new Error("private diagnostic"), { code: "unknown_code", message: "private diagnostic" }])("never exposes unknown codes or raw diagnostics", error => {
    notify(input(error));
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent", expect.objectContaining({
      description: "Review the conversation before retrying.",
    }));
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain("private diagnostic");
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain("unknown_code");
  });

  it.each(["/personal/local", "/organization/local"])("shows the generic Local copy for %s", folder => {
    notify(input("private detail", { folder }));
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent", expect.objectContaining({ action: undefined }));
  });

  it.each([
    ["queued_timeout", "Message wasn't sent in time", "Retry"],
    ["history_unavailable", "Couldn't load chat history", "Retry"],
    ["workspace_start_timeout", "Workspace is still starting", "Retry"],
    ["workspace_stopped", "Cloud workspace stopped", "Retry"],
    ["user_stopped", "Stopped before sending", undefined],
    ["workspace_archived", "Cloud workspace is archived", undefined],
    ["workspace_unavailable", "Cloud workspace is unavailable", "Retry"],
    ["unknown", "Message wasn't sent", undefined],
  ] as const)("presents %s with only its relevant action", (reason, message, label) => {
    const retry = vi.fn();
    expect(notify(input(undefined, { reason, onRetry: retry }))).toBe(true);
    const [copy, options] = mocks.error.mock.calls[0];
    expect(copy).toBe(message);
    expect(options.action?.label).toBe(label);
    if (label === "Retry") {
      options.action.onClick();
      expect(retry).toHaveBeenCalledOnce();
    }
  });

  it("shares queue UUID dedupe with the promoted turn, even when its failure reason changes", () => {
    const queued = input(undefined, { attemptId: "queued-message-uuid", reason: "queued_timeout" });
    expect(notify(queued)).toBe(true);
    expect(notify({ ...queued, reason: "workspace_unavailable" })).toBe(false);
    expect(mocks.error).toHaveBeenCalledOnce();
  });
});
