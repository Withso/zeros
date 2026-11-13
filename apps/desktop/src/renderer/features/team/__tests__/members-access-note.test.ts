import { describe, expect, it } from "vitest";
import { membershipAccessNote } from "../members-access-note";

describe("§16: the members panel tells owners and admins what members can read", () => {
  it("shows the line to owners and admins only once the server applies membership access", () => {
    const line = "Members can open every cloud workspace in this organization and read its code. Their own GitHub access is needed only to push or open pull requests.";
    expect(membershipAccessNote({ role: "owner", workspaceAccess: "membership" })).toBe(line);
    expect(membershipAccessNote({ role: "admin", workspaceAccess: "membership" })).toBe(line);
    expect(membershipAccessNote({ role: "member", workspaceAccess: "membership" })).toBeNull();
    // An older control plane still hides workspaces from members without repository access: no line.
    expect(membershipAccessNote({ role: "owner" })).toBeNull();
    expect(membershipAccessNote({ role: "owner", workspaceAccess: "repository" as never })).toBeNull();
  });
});
