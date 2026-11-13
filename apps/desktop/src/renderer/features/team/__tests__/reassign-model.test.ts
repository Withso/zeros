import { describe, expect, it } from "vitest";
import { reassignCandidateRows, reassignConfirmCopy, reassignErrorMessage, reassignNextRequestId } from "../reassign-model";

const sam = "55555555-5555-4555-8555-555555555555", kim = "66666666-6666-4666-8666-666666666666", lee = "77777777-7777-4777-8777-777777777777";
const roster = [{ id: sam, name: "Sam", avatarUrl: null, role: "member" }, { id: kim, name: "Kim", avatarUrl: null, role: "member" }, { id: lee, name: "Lee", avatarUrl: null, role: "admin" }];

describe("the Reassign dialog's model", () => {
  it("lists eligible people first by name, explains each ineligible one, and says which agents an eligible person can't run (presentation only)", () => {
    expect(reassignCandidateRows([
      { userId: kim, eligible: false, reason: "on_hold" },
      { userId: sam, eligible: true, agentLogins: { claude: true } },
      { userId: lee, eligible: true },
    ], roster)).toEqual([
      { userId: lee, name: "Lee", eligible: true, hint: null },
      { userId: sam, name: "Sam", eligible: true, hint: "No Codex or Cursor login" },
      { userId: kim, name: "Kim", eligible: false, hint: "On hold" },
    ]);
    expect(reassignCandidateRows([{ userId: sam, eligible: true, agentLogins: {} }, { userId: kim, eligible: false, reason: "repository_access_required" },
      { userId: "88888888-8888-4888-8888-888888888888", eligible: false, reason: "account_inactive" }], roster).map(row => row.hint))
      .toEqual(["No agent login", "Account inactive", "No repository access"]);
  });

  it("names who will pay for turns, and who keeps following", () => {
    expect(reassignConfirmCopy({ workspace: "w-7", to: "Sam", caller: "creator", creator: "you" })).toEqual({
      title: "Make Sam the Creator of w-7?", body: "Sam's agent logins will run every turn here.", follow: "You'll keep following it." });
    expect(reassignConfirmCopy({ workspace: "w-7", to: "Sam", caller: "admin", creator: "Alex" }).follow).toBe("Alex will keep following it.");
    expect(reassignConfirmCopy({ workspace: "w-7", to: "Sam", caller: "admin", creator: null }).follow).toBeNull();
  });

  it("says what each refusal means, in a closed set", () => {
    expect(reassignErrorMessage("creator_changed")).toBe("Someone else changed the Creator. The list is up to date now.");
    expect(reassignErrorMessage("assignee_ineligible", "Sam")).toBe("Sam can't be the Creator of this workspace.");
    expect(reassignErrorMessage("github_verification_unavailable")).toBe("Can't check repository access right now. Try again.");
    expect(reassignErrorMessage("rate_limited")).toBe("Too many changes. Try again shortly.");
    expect(reassignErrorMessage("anything_else")).toBe("The Creator couldn't be changed. Try again.");
  });

  it("reuses a request id for a retry of the same choice, and makes a new one for another choice or after a conflict", () => {
    const first = reassignNextRequestId(undefined, sam, () => "a");
    expect(first).toEqual({ requestId: "a", toUserId: sam });
    expect(reassignNextRequestId(first, sam, () => "b")).toBe(first);
    expect(reassignNextRequestId(first, kim, () => "c")).toEqual({ requestId: "c", toUserId: kim });
    expect(reassignNextRequestId(undefined, sam, () => "d")).toEqual({ requestId: "d", toUserId: sam });
  });
});
