// collectAgentCredEnv — the allowlist that couriers the provisioner's agent
// credentials into a cloud sandbox at create() time. It must (a) pass through
// ONLY set + non-blank allowlisted vars (an empty env would mask the real key
// with a blank one), and (b) NEVER blanket-copy process.env (that would leak
// DAYTONA_API_KEY and friends into the box).

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  bridgeWsUrl,
  clearState,
  collectAgentCredEnv,
  loadState,
  saveState,
  type CloudValidationState,
} from "../cloud-workspace-validation/config";

const tempRoots: string[] = [];

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

describe("cloud validation connection state", () => {
  const state: CloudValidationState = {
    sandboxId: "sandbox-test",
    previewUrl: "https://preview.example.test",
    previewToken: "preview-token-placeholder",
    cloudToken: "cloud-token-placeholder",
    region: "test",
    createdAt: "2026-08-05T00:00:00.000Z",
  };

  const statePath = () => {
    const root = mkdtempSync(join(tmpdir(), "zeros-cloud-validation-"));
    tempRoots.push(root);
    return join(root, "private", "state.json");
  };

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("atomically writes owner-only state and removes it during cleanup", () => {
    const file = statePath();
    saveState(state, file);

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state);
    expect(loadState(file)).toEqual(state);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);

    const refreshed = { ...state, region: "updated" };
    saveState(refreshed, file);
    expect(loadState(file)).toEqual(refreshed);

    clearState(file);
    expect(existsSync(file)).toBe(false);
  });

  it("keeps the cloud bearer out of the WebSocket request target", () => {
    const url = bridgeWsUrl(
      "https://preview.example.test/original?token=legacy-query-value",
    );
    const parsed = new URL(url);

    expect(parsed.protocol).toBe("wss:");
    expect(parsed.pathname).toBe("/ws");
    expect(parsed.searchParams.has("token")).toBe(false);
  });
});
