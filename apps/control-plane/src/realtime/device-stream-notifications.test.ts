import { describe, expect, it, vi } from "vitest";

import { DEVICE_STREAM_CATALOG_CHANNEL, DEVICE_STREAM_TURN_CHANNEL, handleDeviceStreamNotification } from "./device-stream-notifications.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const notice = { id: "00000000-0000-4000-8000-000000000009", kind: "turn.completed", workspaceId, chatId: "chat",
  turnId: "turn-1", title: "Turn completed", createdAt: "2026-01-01T00:00:00.000Z" };
const server = () => ({ workspaceChanged: vi.fn(), publishNotification: vi.fn() });

describe("device stream notifications", () => {
  it("publishes a valid turn notification exactly as received", () => {
    const s = server(); handleDeviceStreamNotification(s, DEVICE_STREAM_TURN_CHANNEL, JSON.stringify(notice));
    expect(s.publishNotification).toHaveBeenCalledWith(notice);
    expect(s.workspaceChanged).not.toHaveBeenCalled();
  });
  it.each(["{", JSON.stringify({ ...notice, kind: "workspace.stopped" }), JSON.stringify({ ...notice, extra: 1 }),
    JSON.stringify({ ...notice, title: "x".repeat(65) }), JSON.stringify({ ...notice, workspaceId: "w" })])("ignores %s", payload => {
    const s = server(); handleDeviceStreamNotification(s, DEVICE_STREAM_TURN_CHANNEL, payload);
    expect(s.publishNotification).not.toHaveBeenCalled();
  });
  it("still routes catalog hints", () => {
    const s = server(); handleDeviceStreamNotification(s, DEVICE_STREAM_CATALOG_CHANNEL, `${workspaceId}:3`);
    expect(s.workspaceChanged).toHaveBeenCalledWith(workspaceId);
  });
});
