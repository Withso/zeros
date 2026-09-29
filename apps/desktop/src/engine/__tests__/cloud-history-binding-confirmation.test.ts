import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock("../db/chats", async original => ({
  ...await original<typeof import("../db/chats")>(), updateChatProviderIdentity: state.persist,
}));
import { ZerosEngine } from "../zeros-engine";

afterEach(() => vi.restoreAllMocks());
it.each(["written", "missing", "failed"] as const)("confirms history reset only after the binding was durably written (%s)", async outcome => {
  state.persist.mockReset().mockImplementation(() => {
    if (outcome === "failed") throw new Error("synthetic persistence failure");
    return outcome === "written";
  });
  const confirm = vi.fn(async () => { expect(state.persist).toHaveReturnedWith(true); });
  const engine = Object.assign(Object.create(ZerosEngine.prototype), {
    agents: { confirmCloudHistoryBinding: confirm }, cloudCommandSessions: new Map(),
  });
  const binding = { version: 1, providerId: "claude", kind: "native", resumeId: "new-owner-binding" };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  engine.persistProviderIdentityForChat("chat", "claude", binding, undefined, "execution");
  await Promise.resolve();
  if (outcome === "written") expect(confirm).toHaveBeenCalledWith("execution", binding);
  else expect(confirm).not.toHaveBeenCalled();
});
