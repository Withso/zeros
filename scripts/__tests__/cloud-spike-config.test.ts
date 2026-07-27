// collectAgentCredEnv — the allowlist that couriers the provisioner's agent
// credentials into a cloud sandbox at create() time. It must (a) pass through
// ONLY set + non-blank allowlisted vars (an empty env would mask the real key
// with a blank one), and (b) NEVER blanket-copy process.env (that would leak
// DAYTONA_API_KEY and friends into the box).

import { afterEach, describe, expect, it } from "vitest";

import { collectAgentCredEnv } from "../cloud-spike/config";

describe("collectAgentCredEnv", () => {
  const saved = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined) => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it("passes through only the set credential vars, trimmed", () => {
    setEnv("ANTHROPIC_API_KEY", "sk-ant-123");
    setEnv("OPENAI_API_KEY", ""); // blank must NOT become an empty env in the box
    setEnv("CURSOR_API_KEY", "  cur-xyz  "); // trimmed
    const env = collectAgentCredEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-123");
    expect(env.CURSOR_API_KEY).toBe("cur-xyz");
    expect("OPENAI_API_KEY" in env).toBe(false);
  });

  it("never passes a non-allowlisted var (no blanket process.env copy)", () => {
    setEnv("DAYTONA_API_KEY", "leak-me");
    expect("DAYTONA_API_KEY" in collectAgentCredEnv()).toBe(false);
  });
});
