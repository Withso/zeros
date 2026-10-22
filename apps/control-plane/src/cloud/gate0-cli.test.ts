import { describe, expect, it, vi } from "vitest";
import { gate0DevTarget, gate0LocalTarget, gate0LocalIdentity, gate0ModelsFromEnv, gate0SignIn } from "./gate0-cli.js";

const owner = "a".repeat(24);
describe("gate0 Dev identity and sign-in", () => {
  it("reads only explicit gate0 model overrides and keeps cheap defaults for empty placeholders", () => {
    expect(gate0ModelsFromEnv({ OPENAI_MODEL: "expensive-ambient-model", ZEROS_GATE0_CLAUDE_MODEL: "" })).toEqual({
      codex: "gpt-6-luna", claude: "claude-haiku-5-5", cursor: "default",
    });
    expect(gate0ModelsFromEnv({ ZEROS_GATE0_CODEX_MODEL: "fixture-codex", ZEROS_GATE0_CLAUDE_MODEL: "fixture-claude", ZEROS_GATE0_CURSOR_MODEL: "fixture-cursor" })).toEqual({
      codex: "fixture-codex", claude: "fixture-claude", cursor: "fixture-cursor",
    });
  });
  const local = { owner, runId: "11111111-1111-4111-8111-111111111111", apiPort: 23456 };
  it("binds local gate0 to the saved instance's tunnel or loopback port", () => {
    expect(gate0LocalTarget(undefined, "example.test", local)).toEqual({ origin: `https://api-dev-${owner}.example.test`, owner });
    for (const host of ["127.0.0.1", "localhost"]) {
      expect(gate0LocalTarget(`http://${host}:23456`, "example.test", local)).toEqual({ origin: `http://${host}:23456`, owner });
    }
    for (const target of ["https://api-alpha.example.test", "http://127.0.0.1:23457", "http://127.0.0.2:23456",
      `https://api-dev-${"b".repeat(24)}.example.test`, "http://localhost:23456/?ticket=private", "http://private@localhost:23456"]) {
      expect(() => gate0LocalTarget(target, "example.test", local)).toThrow("local_target");
    }
  });

  it("requires the saved local run ID and refuses a hosted generation before using credentials", () => {
    expect(() => gate0LocalIdentity({ ok: true, development: { owner, runId: local.runId } }, local)).not.toThrow();
    for (const health of [
      { ok: false, development: { owner, runId: local.runId } },
      { ok: true, development: { owner, runId: "22222222-2222-4222-8222-222222222222" } },
      { ok: true, development: { owner: "b".repeat(24), runId: local.runId } },
      { ok: true, development: { owner, runId: local.runId, generation: local.runId } },
    ]) expect(() => gate0LocalIdentity(health, local)).toThrow("local_identity");
  });

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
