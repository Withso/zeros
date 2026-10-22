import { describe, expect, it } from "vitest";
import { messageEditAvailable, permissionModesAvailable, turnCheckpointsAvailable } from "../chat-feature-availability";

describe("permission mode availability", () => {
  it("keeps Plan and the other permission modes for Local and unbound chats", () => {
    expect(permissionModesAvailable("/Users/me/project")).toBe(true);
    expect(permissionModesAvailable(null)).toBe(true);
    expect(permissionModesAvailable(undefined)).toBe(true);
  });
  it("hides them for cloud workspaces, whose agents run with full permissions", () => {
    expect(permissionModesAvailable("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222")).toBe(false);
    expect(permissionModesAvailable("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/packages/app")).toBe(false);
  });
  it("keeps turn records, reset and undo for Local chats and hides them for cloud chats", () => {
    expect(turnCheckpointsAvailable("2f6a8b2e-0000-4000-8000-000000000000")).toBe(true);
    expect(turnCheckpointsAvailable("cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:chat")).toBe(false);
  });
  it("keeps edit-and-resend for Local chats and hides it for cloud chats, whose worker cannot rewind history", () => {
    expect(messageEditAvailable("/Users/me/project")).toBe(true);
    expect(messageEditAvailable(null)).toBe(true);
    expect(messageEditAvailable("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222")).toBe(false);
  });
});
