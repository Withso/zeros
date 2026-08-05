import { describe, it, expect } from "vitest";
import {
  parseBridgeMessage,
  safeParseBridgeMessage,
  KNOWN_MESSAGE_TYPES,
} from "../schemas";

const base = { id: "1", timestamp: 0 } as const;

describe("parseBridgeMessage — trust-boundary validation", () => {
  it("accepts DB_CHANGED (regression: was missing from KNOWN_MESSAGE_TYPES)", () => {
    expect(KNOWN_MESSAGE_TYPES).toContain("DB_CHANGED");
    const m = parseBridgeMessage({
      ...base,
      source: "engine",
      type: "DB_CHANGED",
      kinds: ["workspaces"],
      workspaceIds: ["workspace-a", "workspace-b"],
    });
    expect(m.type).toBe("DB_CHANGED");
    if (m.type === "DB_CHANGED") {
      expect(m.workspaceIds).toEqual(["workspace-a", "workspace-b"]);
    }
  });

  it("rejects an unknown message type", () => {
    expect(() =>
      parseBridgeMessage({ ...base, source: "browser", type: "NOPE" }),
    ).toThrow(/Unknown bridge message type/);
  });

  it("rejects a malformed envelope", () => {
    expect(() => parseBridgeMessage({ type: "HEARTBEAT" })).toThrow();
  });

  it("rejects type-confused payloads on remote write-reaching types", () => {
    const b = { ...base, source: "browser" as const };
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "PTY_RESIZE",
        sessionId: "s",
        cols: "80",
        rows: 24,
      }),
    ).toThrow(/cols/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_SET_MODE",
        agentId: "a",
        sessionId: "s",
        modeId: {},
      }),
    ).toThrow(/modeId/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "WORKSPACE_REQUEST", op: 5 }),
    ).toThrow(/op/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "PTY_WRITE", sessionId: "s", data: 5 }),
    ).toThrow(/data/);
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_PROMPT",
        agentId: "a",
        sessionId: "s",
        prompt: "hi",
      }),
    ).toThrow(/prompt/);
    // WORKSPACE_APPROVAL_RESPONSE was removed with the dead host-approval
    // broker: it must now be rejected as an UNKNOWN type, not field-validated.
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "WORKSPACE_APPROVAL_RESPONSE",
        approvalId: "x",
        approved: true,
      }),
    ).toThrow(/Unknown bridge message type/);
  });

  it("accepts well-formed write payloads", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      parseBridgeMessage({
        ...b,
        type: "PTY_RESIZE",
        sessionId: "s",
        cols: 80,
        rows: 24,
      }).type,
    ).toBe("PTY_RESIZE");
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_PROMPT",
        agentId: "a",
        sessionId: "s",
        prompt: [],
      }).type,
    ).toBe("AGENT_PROMPT");
    expect(
      parseBridgeMessage({
        ...b,
        type: "WORKSPACE_REQUEST",
        op: "git.status",
        params: {},
      }).type,
    ).toBe("WORKSPACE_REQUEST");
    expect(
      parseBridgeMessage({
        ...b,
        type: "AGENT_STOP_BACKGROUND_TASK",
        agentId: "claude",
        sessionId: "s",
        taskId: "task-1",
      }).type,
    ).toBe("AGENT_STOP_BACKGROUND_TASK");
  });

  it("rejects an invalid background-task stop target", () => {
    const b = { ...base, source: "browser" as const };
    expect(() =>
      parseBridgeMessage({
        ...b,
        type: "AGENT_STOP_BACKGROUND_TASK",
        agentId: "claude",
        sessionId: "s",
        taskId: "",
      }),
    ).toThrow(/taskId/);
  });

  it("stays permissive for engine→client / non-write types", () => {
    const b = { ...base, source: "engine" as const };
    // No payload fields — should pass (only the inbound write set is strict).
    expect(parseBridgeMessage({ ...b, type: "HEARTBEAT" }).type).toBe(
      "HEARTBEAT",
    );
    expect(
      parseBridgeMessage({ ...b, type: "AGENT_SESSION_UPDATE", sessionId: "s" })
        .type,
    ).toBe("AGENT_SESSION_UPDATE");
  });

  it("validates RESOLVE_AGENT_BINARY + accepts the PTY_CREATE ephemeral flag", () => {
    const b = { ...base, source: "browser" as const };
    // agentId is required (the handler reads it).
    expect(() =>
      parseBridgeMessage({ ...b, type: "RESOLVE_AGENT_BINARY" }),
    ).toThrow(/agentId/);
    expect(() =>
      parseBridgeMessage({ ...b, type: "RESOLVE_AGENT_BINARY", agentId: 5 }),
    ).toThrow(/agentId/);
    expect(
      parseBridgeMessage({
        ...b,
        type: "RESOLVE_AGENT_BINARY",
        agentId: "claude",
      }).type,
    ).toBe("RESOLVE_AGENT_BINARY");
    // The new optional ephemeral flag round-trips on PTY_CREATE.
    expect(
      parseBridgeMessage({
        ...b,
        type: "PTY_CREATE",
        sessionId: "s",
        ephemeral: true,
      }).type,
    ).toBe("PTY_CREATE");
    // The engine→client reply is a known type (drift guard).
    expect(KNOWN_MESSAGE_TYPES).toContain("AGENT_BINARY_RESOLVED");
  });

  it("safeParseBridgeMessage returns null on a malformed write payload", () => {
    const b = { ...base, source: "browser" as const };
    expect(
      safeParseBridgeMessage({
        ...b,
        type: "PTY_RESIZE",
        sessionId: "s",
        cols: "x",
        rows: 1,
      }),
    ).toBeNull();
    expect(
      safeParseBridgeMessage({
        ...b,
        type: "PTY_RESIZE",
        sessionId: "s",
        cols: 80,
        rows: 24,
      }),
    ).not.toBeNull();
  });
});
