import { describe, expect, it, vi } from "vitest";
import { gate0DevTarget, gate0SignIn } from "./gate0-cli.js";

const owner = "a".repeat(24);
describe("gate0 Dev identity and sign-in", () => {
  it("accepts only the selected profile's workspace-specific Dev origin", () => {
    expect(gate0DevTarget(`https://api-dev-${owner}.example.test`, "example.test")).toEqual({ origin: `https://api-dev-${owner}.example.test`, owner });
    for (const target of ["https://api-alpha.example.test", "https://api.example.test", `http://api-dev-${owner}.example.test`,
      `https://api-dev-${owner}.foreign.test`, `https://api-dev-${owner}.example.test/?ticket=hidden`,
      `https://private@api-dev-${owner}.example.test`, `https://api-dev-${owner}.example.test:8443`]) {
      expect(() => gate0DevTarget(target, "example.test")).toThrow("dev_target");
    }
  });

  const input = { clientId: "client_fixture", apiKey: "synthetic-profile-key", email: "probe@example.test", password: "synthetic-test-password", subject: "user_fixture" };
  function grant(seconds = 600, subject = input.subject) {
    const token = [{ alg: "RS256" }, { sid: "session_fixture", exp: Math.floor(Date.now() / 1000) + seconds }, "signature"]
      .map(value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url")).join(".");
    return { access_token: token, refresh_token: "synthetic-refresh-token", authentication_method: "Password", user: { id: subject, email: input.email, email_verified: true } };
  }

  it("signs in once, refreshes its own session, and revokes only that session", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(grant(30)))
      .mockResolvedValueOnce(Response.json(grant())).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const session = await gate0SignIn(input, fetchImpl);
    expect(await session.accessToken()).toBeTypeOf("string");
    await session.close();
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.workos.com/user_management/authenticate", "https://api.workos.com/user_management/authenticate", "https://api.workos.com/user_management/sessions/revoke",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toMatchObject({ grant_type: "password", password: input.password });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "synthetic-refresh-token" });
    expect(JSON.parse(String(fetchImpl.mock.calls[2]![1]!.body))).toEqual({ session_id: "session_fixture" });
    expect(fetchImpl.mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
  });

  it("revokes a login for the wrong test identity and keeps provider errors private", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(grant(600, "user_wrong")))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(gate0SignIn(input, fetchImpl)).rejects.toThrow("sign_in_identity");
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("sessions/revoke");
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: input.password }, { status: 401 }));
    await expect(gate0SignIn(input, failed)).rejects.toThrow(/^Cloud v2 gate0 failed: sign_in$/);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
