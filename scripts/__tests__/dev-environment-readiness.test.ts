import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDevSignIn } from "../dev-environment/processes.mjs";

afterEach(() => vi.unstubAllGlobals());
const profile = { appOrigin: "https://app-dev-example.example.test", webClientId: "client_test" };
function authorize(callback = `${profile.appOrigin}/auth/callback`) {
  const url = new URL("https://api.workos.com/user_management/authorize");
  url.searchParams.set("client_id", profile.webClientId); url.searchParams.set("redirect_uri", callback);
  return url.toString();
}

describe("Dev sign-in readiness", () => {
  it("uses the existing auth/start route and its 303 WorkOS redirect", async () => {
    const fetch = vi.fn(async url => String(url) === `${profile.appOrigin}/auth/start`
      ? new Response(null, { status: 303, headers: { location: authorize() } })
      : new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(waitForDevSignIn(profile, { timeout: 50 })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not accept a redirect that sends the user to another workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 303,
      headers: { location: authorize("https://other.example.test/auth/callback") } })));
    await expect(waitForDevSignIn(profile, { timeout: 5 })).rejects.toThrow(/ready/);
  });
});
