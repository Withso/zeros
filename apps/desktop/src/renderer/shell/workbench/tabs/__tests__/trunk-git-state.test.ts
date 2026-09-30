import { describe, expect, it } from "vitest";
import { nativeTrunkRoot } from "../changes-tab";

describe("trunk Git probe root", () => {
  it("probes a Local folder", () => {
    expect(nativeTrunkRoot("/Users/me/project")).toBe("/Users/me/project");
  });
  it("never probes a cloud workspace key as a Local path", () => {
    // Cloud trunks reuse the Local main row with a cloud:// root; the native
    // probe would run `git -C cloud://…` on this Mac.
    expect(nativeTrunkRoot("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(nativeTrunkRoot("CLOUD://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/sub")).toBeNull();
  });
  it("keeps worktrees and missing roots unprobed", () => {
    expect(nativeTrunkRoot(null)).toBeNull();
    expect(nativeTrunkRoot("")).toBeNull();
  });
});
