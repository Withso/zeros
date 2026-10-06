import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineActivityFrame, EngineActivityHeartbeat } from "../engine-activity-heartbeat";
import { ZerosEngine } from "../index";
import type { EngineMessage } from "../types";
import type { TransportClient } from "../transport/types";
import type { BackgroundTasksUpdate, SessionNotification, LoadSessionResponse } from "@zeros/protocol/agent-events";

interface PromptLease {
  sessionId: string;
  agentId: string;
  chatId: null;
  turnId: string;
  promptId: string;
  startedAt: number;
  lastActivityAt: number;
}

interface ActivityInternals {
  local: { instanceNonce: string };
  activityHeartbeat: EngineActivityHeartbeat;
  publishPrivateHostControl(line: string): void;
  handleMessage(message: EngineMessage, client: TransportClient): Promise<void>;
  handleWorkspaceMessage(message: EngineMessage, client: TransportClient): Promise<void>;
  enterPrompt(prompt: PromptLease): void;
  exitPrompt(prompt: PromptLease): void;
  clearBusy(): void;
  sessionAgent: Map<string, string>;
  sessionLoadResponses: Map<string, LoadSessionResponse>;
  agents: {
    events: { onSessionUpdate(agentId: string, notification: SessionNotification): void };
    endSession(agentId: string, executionId: string, options?: { failClosed?: boolean }): Promise<void>;
    prompt(...args: unknown[]): Promise<unknown>;
  };
  sessionWorkspace: Map<string, string>;
  clearAgentExecutionRoute(executionId: string): void;
  workspace: {
    workspaceProcessReaper(workspaceId: string, folder: string): Promise<void>;
    workspaceIdForCwd(folder?: string): string | null;
  };
}

describe("engine private activity integration", () => {
  let root: string;
  let engine: ZerosEngine;
  let state: ActivityInternals;
  let frames: EngineActivityFrame[];
  let client: TransportClient;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "zeros-activity-lifecycle-")));
    await mkdir(path.join(root, "workspace"));
    engine = new ZerosEngine({ root, port: 29_884 });
    state = engine as unknown as ActivityInternals;
    frames = [];
    vi.spyOn(state, "publishPrivateHostControl").mockImplementation((line) => {
      expect(line.endsWith("\n")).toBe(true);
      frames.push(JSON.parse(line) as EngineActivityFrame);
    });
    client = { id: "activity-client", kind: "local", send: vi.fn(), close: vi.fn() };
  });

  afterEach(async () => {
    state.activityHeartbeat?.stop();
    state.clearBusy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("retains dispatch work in exact-instance frames until its handler settles", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const work = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(state, "handleWorkspaceMessage").mockReturnValue(work);
    state.activityHeartbeat.start();
    const request = state.handleMessage({ type: "WORKSPACE_REQUEST", id: "request", source: "browser", timestamp: 1,
      op: "git.hasChanges", params: { workspaceId: "ws_fixture" } }, client);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(frames.at(-1)).toMatchObject({ type: "engine.heartbeat", instance: state.local.instanceNonce, activeRequests: 1, activeTurns: 0 });
    release();
    await request;
    expect(frames.at(-1)).toMatchObject({ activeRequests: 0 });
    expect(frames.map((frame) => frame.sequence)).toEqual(frames.map((_frame, index) => index + 1));
  });

  it("keeps the ordinary local workspace dispatcher and activity tracking for cloud-only operations", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const handler = vi.spyOn(state, "handleWorkspaceMessage").mockReturnValue(held);
    state.activityHeartbeat.start();
    const localRuntime = engine as unknown as { cloudWorker: unknown; cloudCommands: unknown; cloudDurabilityRuntime: unknown;
      cloudHumanServices: unknown; cloudLanguageServices: unknown; cloudIdleBusy(): boolean };
    for (const service of [localRuntime.cloudWorker, localRuntime.cloudCommands, localRuntime.cloudDurabilityRuntime,
      localRuntime.cloudHumanServices, localRuntime.cloudLanguageServices]) expect(service).toBeNull();
    expect(localRuntime.cloudIdleBusy()).toBe(true);
    const request = state.handleMessage({ type: "WORKSPACE_REQUEST", id: "local-presence", source: "browser", timestamp: 1,
      op: "cloudPresence.update", params: { present: true } }, client);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(handler).toHaveBeenCalledOnce();
    expect(frames.at(-1)).toMatchObject({ activeRequests: 1 });
    release(); await request;
    expect(frames.at(-1)).toMatchObject({ activeRequests: 0 });
  });

  it("publishes immediate turn activity edges and preserves a sibling turn's lease", () => {
    vi.useFakeTimers();
    state.activityHeartbeat.start();
    const prompt = (sessionId: string): PromptLease => ({ sessionId, agentId: "claude", chatId: null,
      turnId: `turn-${sessionId}`, promptId: `prompt-${sessionId}`, startedAt: Date.now(), lastActivityAt: Date.now() });
    const target = prompt("target");
    const sibling = prompt("sibling");
    state.enterPrompt(target);
    state.enterPrompt(sibling);
    expect(frames.at(-1)).toMatchObject({ activeTurns: 2 });
    state.exitPrompt(target);
    expect(frames.at(-1)).toMatchObject({ activeTurns: 1 });
    state.exitPrompt(sibling);
    expect(frames.at(-1)).toMatchObject({ activeTurns: 0 });
  });

  it("retires a prompt's activity even when its original request has not settled", async () => {
    vi.useFakeTimers();
    const completions = new Map<string, () => void>();
    const prompt = vi.spyOn(state.agents, "prompt").mockImplementation((_agentId, sessionId) =>
      new Promise((resolve) => {
        completions.set(String(sessionId), () => resolve({ stopReason: "end_turn" }));
      }),
    );
    state.activityHeartbeat.start();
    const requests = ["target", "sibling"].map((sessionId) => {
      state.sessionAgent.set(sessionId, "claude");
      const request = state.handleMessage({ type: "AGENT_PROMPT", id: `request-${sessionId}`,
        source: "browser", timestamp: 1, agentId: "claude", sessionId,
        userMessageId: `turn-${sessionId}`, prompt: [{ type: "text", text: "Continue work" }] }, client);
      // Accepted preamble work already protects the turn before any await.
      expect(frames.at(-1)?.activeTurns).toBe(sessionId === "target" ? 1 : 2);
      return request;
    });
    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      state.clearAgentExecutionRoute("target");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(frames.at(-1)).toMatchObject({ activeRequests: 0, activeTurns: 1 });
      completions.get("target")!();
      await requests[0];
      expect(frames.at(-1)).toMatchObject({ activeRequests: 0, activeTurns: 1 });
      state.clearAgentExecutionRoute("sibling");
      expect(frames.at(-1)).toMatchObject({ activeRequests: 0, activeTurns: 0 });
    } finally {
      for (const complete of completions.values()) complete();
      await Promise.all(requests);
    }
  });

  it("retains exact background and autonomous parent work after prompt settlement without double counting", () => {
    vi.useFakeTimers();
    state.activityHeartbeat.start();
    state.sessionAgent.set("background-parent", "claude");
    const prompt: PromptLease = { sessionId: "background-parent", agentId: "claude", chatId: null,
      turnId: "foreground-turn", promptId: "foreground-prompt", startedAt: Date.now(), lastActivityAt: Date.now() };
    state.enterPrompt(prompt);
    const update = (snapshot: Omit<BackgroundTasksUpdate, "sessionUpdate">) => state.agents.events.onSessionUpdate("claude", {
      executionId: prompt.sessionId, sessionId: prompt.sessionId,
      update: { sessionUpdate: "background_tasks_update", ...snapshot },
    });
    update({ tasks: [{ taskId: "background-task", taskType: "agent", name: "Fixture work", startedAt: 1, updatedAt: 1 }], waiting: true });
    expect(frames.at(-1)).toMatchObject({ activeTurns: 1 });
    state.exitPrompt(prompt);
    expect(frames.at(-1)).toMatchObject({ activeTurns: 1 });
    update({ tasks: [], waiting: false, activity: { state: "running", startedAt: 1 } });
    expect(frames.at(-1)).toMatchObject({ activeTurns: 1 });
    update({ tasks: [], waiting: false, activity: null });
    expect(frames.at(-1)).toMatchObject({ activeTurns: 0 });
  });

  it("drops only a retired background execution and ignores its late snapshots", () => {
    vi.useFakeTimers();
    state.activityHeartbeat.start();
    for (const executionId of ["target-background", "sibling-background"]) {
      state.sessionAgent.set(executionId, "claude");
      state.agents.events.onSessionUpdate("claude", { executionId, sessionId: executionId,
        update: { sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: { state: "running", startedAt: 1 } } });
    }
    expect(frames.at(-1)).toMatchObject({ activeTurns: 2 });
    state.clearAgentExecutionRoute("target-background");
    expect(frames.at(-1)).toMatchObject({ activeTurns: 1 });
    state.agents.events.onSessionUpdate("claude", { executionId: "target-background", sessionId: "target-background",
      update: { sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: { state: "running", startedAt: 1 } } });
    state.activityHeartbeat.refresh();
    expect(frames.at(-1)).toMatchObject({ activeTurns: 1 });
    expect(state.sessionLoadResponses.has("target-background")).toBe(false);
  });

  it("archive removes only its background execution's activity contribution", async () => {
    const folder = path.join(root, "workspace");
    vi.spyOn(state.workspace, "workspaceIdForCwd").mockImplementation((candidate) => candidate === folder ? "ws_target" : null);
    const retire = vi.spyOn(state.agents, "endSession").mockResolvedValue();
    state.activityHeartbeat.start();
    for (const [executionId, workspaceId] of [["target-background", "ws_target"], ["sibling-background", "ws_sibling"]]) {
      state.sessionAgent.set(executionId, "claude");
      state.sessionWorkspace.set(executionId, workspaceId);
      state.agents.events.onSessionUpdate("claude", { executionId, sessionId: executionId,
        update: { sessionUpdate: "background_tasks_update", tasks: [], waiting: false, activity: { state: "running", startedAt: 1 } } });
    }
    expect(frames.at(-1)).toMatchObject({ activeTurns: 2 });
    await state.workspace.workspaceProcessReaper("ws_target", folder);
    expect(frames.at(-1)).toMatchObject({ activeTurns: 1 });
    expect(retire.mock.calls).toEqual([["claude", "target-background", { failClosed: true }]]);
    expect(state.sessionLoadResponses.has("sibling-background")).toBe(true);
    expect(state.sessionAgent.get("sibling-background")).toBe("claude");
  });

  it("stops publication during shutdown even before engine startup completed", async () => {
    vi.useFakeTimers();
    state.activityHeartbeat.start();
    await engine.stop();
    const count = frames.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(frames).toHaveLength(count);
  });

  it("does not treat transport keepalives as active requests", async () => {
    vi.useFakeTimers();
    state.activityHeartbeat.start();
    await state.handleMessage({ type: "HEARTBEAT", id: "keepalive", source: "browser", timestamp: 1 }, client);
    expect(frames).toHaveLength(1);
  });
});
