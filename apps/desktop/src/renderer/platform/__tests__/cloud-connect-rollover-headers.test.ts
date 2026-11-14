import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: auth.getSession }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: null }) }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test",
  ControlPlaneError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
import { connectCloudV2Workspace } from "../cloud-v2";
import { resetClientRolloverHeadersForTests } from "../cloud-workspaces";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const instance = "55555555-5555-4555-8555-555555555555";
const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.s`;
const reply = { url: "wss://api.example.test/v2/cloud/workspaces/w/bridge", protocols: ["zeros.cloud.v2", `ticket.zw2c_${"a".repeat(43)}`], expiresAt: "2030-01-01T00:00:00Z" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); auth.getSession.mockReset(); resetClientRolloverHeadersForTests(); });
const rolloverHeaders = (init: RequestInit) => new Headers(init.headers).get("x-zeros-client-instance");

describe("§14.7: POST connect for a rolling-over peer", () => {
  it("sends the rollover feature with this peer's instance, asks for a newer bearer and reports its expiry, never the token", async () => {
    auth.getSession.mockResolvedValue({ access_token: jwt(1_900_000_000), user: { sub: "u" } });
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(reply)); vi.stubGlobal("fetch", fetch);
    const seen: Array<number | null> = [];
    await connectCloudV2Workspace(target, { wake: false, clientInstance: instance, notExpiringBefore: 1_234_567, presentedTokenExpiry: value => seen.push(value) });
    const headers = new Headers(fetch.mock.calls[0]![1].headers);
    expect([headers.get("x-zeros-client-features"), headers.get("x-zeros-client-instance")]).toEqual(["client-token-rollover-v1,carrier-hold-v1", instance]);
    expect(auth.getSession).toHaveBeenCalledWith({ notExpiringBefore: 1_234_567 });
    expect(seen).toEqual([1_900_000_000_000]);
  });

  it("an ordinary connect sends neither header nor a bound, and an unreadable bearer reports null", async () => {
    auth.getSession.mockResolvedValue({ access_token: "opaque", user: { sub: "u" } });
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(reply)); vi.stubGlobal("fetch", fetch);
    await connectCloudV2Workspace(target, { wake: true });
    const headers = new Headers(fetch.mock.calls[0]![1].headers);
    expect([headers.get("x-zeros-client-features"), headers.get("x-zeros-client-instance")]).toEqual([null, null]);
    expect(auth.getSession).toHaveBeenCalledWith(undefined);
    const seen: Array<number | null> = [];
    await connectCloudV2Workspace(target, { wake: false, clientInstance: "not-a-uuid", presentedTokenExpiry: value => seen.push(value) });
    expect(new Headers(fetch.mock.calls[1]![1].headers).get("x-zeros-client-instance")).toBeNull();
    expect(seen).toEqual([null]);
  });

  it("an N-1 control plane whose CORS preflight refuses the headers: retries once without them and remembers that for this server", async () => {
    vi.useFakeTimers();
    auth.getSession.mockResolvedValue({ access_token: "opaque", user: { sub: "u" } });
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (rolloverHeaders(init)) throw new TypeError("Failed to fetch");
      return Response.json(reply);
    });
    vi.stubGlobal("fetch", fetch);
    await expect(connectCloudV2Workspace(target, { wake: false, clientInstance: instance })).resolves.toMatchObject({ url: reply.url });
    expect(fetch.mock.calls.map(([, init]) => rolloverHeaders(init))).toEqual([instance, null]);
    await connectCloudV2Workspace(target, { wake: false, clientInstance: instance });
    expect(fetch).toHaveBeenCalledTimes(3); expect(rolloverHeaders(fetch.mock.calls[2]![1])).toBeNull();
    // Bounded memory: a later control plane gets the headers offered again.
    vi.advanceTimersByTime(30 * 60_000);
    await connectCloudV2Workspace(target, { wake: false, clientInstance: instance });
    expect(fetch.mock.calls.slice(3).map(([, init]) => rolloverHeaders(init))).toEqual([instance, null]);
  });

  it("never loops: offline fails after one header-less retry and is not remembered; an HTTP refusal is not retried", async () => {
    auth.getSession.mockResolvedValue({ access_token: "opaque", user: { sub: "u" } });
    const offline = vi.fn(async (_url: string, _init: RequestInit) => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", offline);
    await expect(connectCloudV2Workspace(target, { wake: false, clientInstance: instance })).rejects.toBeInstanceOf(TypeError);
    expect(offline).toHaveBeenCalledTimes(2);
    const refused = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 }));
    vi.stubGlobal("fetch", refused);
    await expect(connectCloudV2Workspace(target, { wake: false, clientInstance: instance })).rejects.toMatchObject({ status: 503 });
    expect(refused).toHaveBeenCalledOnce(); expect(rolloverHeaders(refused.mock.calls[0]![1])).toBe(instance);
  });
});
