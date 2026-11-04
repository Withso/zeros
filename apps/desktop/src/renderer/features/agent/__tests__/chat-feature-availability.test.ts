import { describe, expect, it } from "vitest";
import { permissionModesAvailable, turnCheckpointsAvailable } from "../chat-feature-availability";

describe("permission mode availability", () => {
  it("keeps Plan and the other permission modes for Local and unbound chats", () => {
    expect(permissionModesAvailable("/Users/me/project")).toBe(true);
    expect(permissionModesAvailable(null)).toBe(true);
    expect(permissionModesAvailable(undefined)).toBe(true);
  });
  it("hides them for unacknowledged cloud workers", () => {
    expect(permissionModesAvailable("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222")).toBe(false);
    expect(permissionModesAvailable("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/packages/app")).toBe(false);
  });
  it("keeps passive native turn reads Local-only while cloud uses mirrored summaries", () => {
    expect(turnCheckpointsAvailable("2f6a8b2e-0000-4000-8000-000000000000")).toBe(true);
    expect(turnCheckpointsAvailable("cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:chat")).toBe(false);
  });
});


it("uses existing mode controls only after the exact cloud session advertises support", () => {
  const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  const modes = [{ id: "read-only", name: "Plan" }, { id: "full-access", name: "Full access" }];
  expect(permissionModesAvailable(folder, modes)).toBe(true);
  expect(permissionModesAvailable(folder, [])).toBe(false);
  expect(permissionModesAvailable("/local/org/project", [])).toBe(true);
});
