import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import type { RpcProcessOptions } from "../../shared/json-rpc-process";

const native = vi.hoisted(() => ({
  options: undefined as RpcProcessOptions | undefined,
  request: vi.fn(), dispose: vi.fn(async () => {}),
  requirements: undefined as unknown,
}));
vi.mock("../../shared/json-rpc-process", () => ({
  JsonRpcProcess: class {
    constructor(options: RpcProcessOptions) { native.options = options; }
    request = native.request;
    notify() {}
    dispose = native.dispose;
  },
  RpcError: class extends Error {},
}));

import { CodexDriver } from "../driver";
import { providerFailure } from "../../../provider-failure";

const drivers: CodexDriver[] = [];
const params = (method: string) => native.request.mock.calls.filter(([name]) => name === method).at(-1)?.[1];
beforeEach(() => {
  native.requirements = { supportsIndependentSpeedModes: true, requirements: null };
  native.request.mockReset().mockImplementation(async (method: string) => {
    if (method === "configRequirements/read") {
      if (native.requirements instanceof Error) throw native.requirements;
      return native.requirements;
    }
    if (method.startsWith("thread/")) return { thread: { id: "thread-managed" }, model: "gpt-6.1-sol" };
    if (method === "turn/start") return { turn: { id: "turn-1", status: "completed" } };
    return {};
  });
  native.dispose.mockClear();
});
afterEach(async () => { await Promise.all(drivers.splice(0).map(driver => driver.dispose())); });

const managed = (allowedApprovalPolicies: string[] | null, allowedSandboxModes: string[] | null) =>
  ({ supportsIndependentSpeedModes: true, requirements: { allowedApprovalPolicies, allowedSandboxModes } });

async function open(modeId: "read-only" | "full-access") {
  const driver = new CodexDriver({ command: "offline-codex", args: [], environment: {} });
  drivers.push(driver);
  const events: SessionNotification[] = [];
  driver.onEvent(event => events.push(event));
  await driver.open({ sessionId: "execution-managed", cwd: process.cwd(), model: "gpt-6.1-sol", modeId,
    proxy: { baseUrl: "http://127.0.0.1:1/v1", token: "offline-placeholder" } });
  return { driver, events };
}

describe("cloud Codex managed requirements", () => {
  it("starts in the nearest allowed mode and reports it when Full access is blocked", async () => {
    native.requirements = managed(["on-request"], ["read-only", "workspace-write"]);
    const { events } = await open("full-access");

    expect(params("thread/start")).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(events).toContainEqual({ sessionId: "execution-managed", update: { sessionUpdate: "current_mode_update", currentModeId: "read-only" } });
  });

  it("refuses a switch to a blocked mode and keeps sending the allowed policy", async () => {
    native.requirements = managed(["on-request"], ["read-only", "workspace-write"]);
    const { driver } = await open("read-only");

    await expect(driver.setMode("full-access")).rejects.toThrow(/organization's Codex policy/);
    await driver.prompt([{ type: "text", text: "Plan" }]).catch(() => {});
    expect(params("turn/start")).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } });
  });

  it("fails with the organization policy when no cloud mode is allowed", async () => {
    native.requirements = managed(["untrusted"], null);
    await expect(open("full-access")).rejects.toThrow(/organization's Codex policy allows none of Zeros' permission modes/);
    expect(params("thread/start")).toBeUndefined();
  });

  it("keeps Full access unrestricted when the method is unavailable", async () => {
    native.requirements = new Error("Invalid request: unknown variant `configRequirements/read`");
    const { events } = await open("full-access");

    expect(params("thread/start")).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(events.some(event => event.update.sessionUpdate === "current_mode_update")).toBe(false);
  });

  it("never opens Plan as Full access when policy allows only Full access", async () => {
    native.requirements = managed(["never"], null);
    await expect(open("read-only")).rejects.toThrow(/does not allow the "read-only" permission mode/);
    expect(params("thread/start")).toBeUndefined();
  });

  it("reports which modes managed policy blocks, so a queued prompt keeps the bounded mode", async () => {
    native.requirements = managed(["on-request"], ["read-only", "workspace-write"]);
    const { driver } = await open("full-access");
    expect(driver.effectiveMode("full-access")).toBe("read-only");
    expect(driver.effectiveMode("read-only")).toBe("read-only");
  });

  it("keeps the organization-policy text when the worker maps the startup failure for the user", async () => {
    native.requirements = managed(["never"], null);
    const error = await open("read-only").catch((failure: unknown) => failure);
    expect(providerFailure("codex", error, "prompt").message).toMatch(/does not allow the "read-only" permission mode/);
  });
});

