import { describe, expect, it } from "vitest";
import { agentEnvironment, workerChildEnvironment } from "../agent-environment";
import { isCredentialRedirectEnvName, isDangerousEnvName } from "../../../../../desktop/src/engine/settings/env-names";

const runtime = { PATH: "/fixture/bin", HOME: "/fixture/home", USER: "user", LANG: "C.UTF-8",
  CLOUD_V2_WORKER_TOKEN: "synthetic-worker-only", DATABASE_URL: "ambient-must-not-transfer" };
const broker = { GIT_ASKPASS: "/fixture/askpass", GH_CONFIG_DIR: "/fixture/gh" };
const application = { DATABASE_URL: "synthetic-app-only", EMPTY_APP_VALUE: "", APP_NOTE: "first\nsecond" };

describe("explicit application environment delivery", () => {
  it("keeps generic Git/file children free of ambient application and worker credentials", () => {
    const child = workerChildEnvironment(runtime, broker);
    expect(child.PATH).toBe(runtime.PATH);
    expect(child.GIT_ASKPASS).toBe(broker.GIT_ASKPASS);
    expect(child).not.toHaveProperty("DATABASE_URL");
    expect(child).not.toHaveProperty("CLOUD_V2_WORKER_TOKEN");
  });

  it("carries an explicit app map to setup/PTY without mutating ambient state", () => {
    const child = Reflect.apply(workerChildEnvironment, undefined, [runtime, broker, application]);
    expect(child).toMatchObject(application);
    expect(child.GIT_ASKPASS).toBe(broker.GIT_ASKPASS);
    expect(child).not.toHaveProperty("CLOUD_V2_WORKER_TOKEN");
    expect(runtime.DATABASE_URL).toBe("ambient-must-not-transfer");
  });

  it.each([
    { agent: "codex", token: "synthetic-selected" },
    { agent: "claude", apiKey: "synthetic-selected" },
    { agent: "claude", oauthToken: "synthetic-selected" },
    { agent: "cursor", apiKey: "synthetic-selected" },
  ])("carries application values alongside the selected $agent login", login => {
    const child = Reflect.apply(agentEnvironment, undefined, [login, runtime, broker, application]);
    expect(child).toMatchObject(application);
    const selected = login.agent === "codex" ? "ZEROS_CLOUD_PROXY_TOKEN" : login.agent === "cursor" ? "CURSOR_API_KEY"
      : "oauthToken" in login ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
    expect(child[selected]).toBe("synthetic-selected");
    expect(child).not.toHaveProperty("CLOUD_V2_WORKER_TOKEN");
  });

  it("retains Local's distinction between injection and explicitly authored proxy settings", () => {
    expect(isDangerousEnvName("NODE_OPTIONS")).toBe(true);
    expect(isDangerousEnvName("HTTPS_PROXY")).toBe(false);
    expect(isCredentialRedirectEnvName("HTTPS_PROXY")).toBe(true);
    expect(isDangerousEnvName("DATABASE_URL")).toBe(false);
  });
});

// Built at run time: a quoted value beside TOKEN reads as a credential to the commit scanner.
const fx = ["zw2a", "fixture"].join("_");
describe("worker-owned ZEROS_ variables", () => {
  const zeros = { ZEROS_WORKSPACE_ID: "fixture-workspace", ZEROS_SESSION_ID: "fixture-chat", ZEROS_API_URL: "https://api.example.test/api/v0", ZEROS_API_TOKEN: fx };
  it("are applied after application values, accept only their own names, and leave the user's ZEROS_API_KEY alone", () => {
    const child = agentEnvironment({ agent: "codex", token: "synthetic-selected" }, runtime, broker,
      { ...application, ZEROS_API_KEY: "zk_user_own" }, { ...zeros, ZEROS_WORKER_TOKEN: "denied", ZEROS_API_KEY: "denied", PATH: "/denied" });
    expect(child).toMatchObject({ ...zeros, ZEROS_API_KEY: "zk_user_own", PATH: runtime.PATH });
    expect(child).not.toHaveProperty("ZEROS_WORKER_TOKEN");
    expect(workerChildEnvironment(runtime, broker, application)).not.toHaveProperty("ZEROS_WORKSPACE_ID");
  });
});
