import { describe, expect, it } from "vitest";
import { designContextReferenceSchema } from "../design-context";

const reference = {
  version: 1,
  workspaceId: "ws_one",
  directoryId: "design_one",
  frame: "home.html",
  revision: "a".repeat(24),
};
describe("Design context references", () => {
  it("round-trips a versioned frame or node reference without a write capability", () => {
    expect(designContextReferenceSchema.parse(reference)).toEqual(reference);
    expect(
      designContextReferenceSchema.parse({ ...reference, nodeId: "heading" })
        .nodeId,
    ).toBe("heading");
    expect(
      designContextReferenceSchema.safeParse({
        ...reference,
        capability: "write",
      }).success,
    ).toBe(false);
  });
  it.each([
    { version: 2 },
    { frame: "../home.html" },
    { frame: "/home.html" },
    { revision: "latest" },
    { nodeId: "\0" },
    { directoryId: "x".repeat(129) },
  ])("rejects unsupported or unsafe references: %j", (patch) => {
    expect(
      designContextReferenceSchema.safeParse({ ...reference, ...patch })
        .success,
    ).toBe(false);
  });
});
