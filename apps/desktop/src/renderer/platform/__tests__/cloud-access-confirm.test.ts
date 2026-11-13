import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: null }) }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test",
  ControlPlaneError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
import { confirmCloudWorkspaceAccessEnded } from "../cloud-access-confirm";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const doc = { id: target.workspaceId, organizationId: target.organizationId, creatorUserId: "44444444-4444-4444-8444-444444444444", name: "w", repository: "o/r",
  branch: "b", baseBranch: "main", state: "running", errorCode: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 2,
  capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] } };
afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) => { const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body, { status })); vi.stubGlobal("fetch", fetch); return fetch; };

describe("D2: confirming that access really ended", () => {
  it("reads the document with the normal team headers, so a member's read does not 404", async () => {
    const fetch = answer(200, { workspace: doc });
    expect(await confirmCloudWorkspaceAccessEnded(target)).toBe("present");
    const headers = new Headers(fetch.mock.calls[0]![1].headers);
    expect([headers.get("x-zeros-team-sharing"), headers.get("x-zeros-team-ownership")]).toEqual(["1", "1"]);
  });
  it("is ended only for 404 or 403 member_access_revoked; every other failure is unknown", async () => {
    answer(404, { error: { code: "not_found", message: "x" } }); expect(await confirmCloudWorkspaceAccessEnded(target)).toBe("ended");
    answer(403, { error: { code: "member_access_revoked", message: "x" } }); expect(await confirmCloudWorkspaceAccessEnded(target)).toBe("ended");
    for (const [status, code] of [[503, "unavailable"], [429, "rate_limited"], [403, "workspace_read_only"], [500, "x"]] as const) {
      answer(status, { error: { code, message: "x" } }); expect(await confirmCloudWorkspaceAccessEnded(target)).toBe("unknown");
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(await confirmCloudWorkspaceAccessEnded(target)).toBe("unknown");
  });
});

describe("D2: the events stream's end", () => {
  it("reports access ended only when confirmed, and never after the account changed meanwhile, or when the read failed", async () => {
    const { reportIfCloudWorkspaceAccessEnded } = await import("../cloud-access-confirm");
    const { registerAccessAccountScope, resetWorkspaceAccessForTests, workspaceAccessEnded } = await import("../team-sharing-registry");
    resetWorkspaceAccessForTests();
    let scope = "user-1#1"; registerAccessAccountScope(() => scope);
    await reportIfCloudWorkspaceAccessEnded(target, async () => "unknown");
    expect(workspaceAccessEnded(target)).toBe(false);
    await reportIfCloudWorkspaceAccessEnded(target, async () => { scope = "creator#2"; return "ended"; });
    expect(workspaceAccessEnded(target)).toBe(false);
    scope = "user-1#3";
    await reportIfCloudWorkspaceAccessEnded(target, async () => "ended");
    expect(workspaceAccessEnded(target)).toBe(true);
  });
});
