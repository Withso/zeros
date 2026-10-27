import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ invoke: vi.fn(), effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { io.effects.push(effect); },
}));
vi.mock("../../../platform/runtime", () => ({
  isElectron: () => true,
  isLocalDevelopment: () => false,
  nativeInvoke: io.invoke,
  nativeListen: async () => () => {},
}));

beforeEach(() => {
  vi.resetModules();
  io.invoke.mockReset();
  io.effects.length = 0;
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("does not clear a new session when an earlier provider startup resync rejects", async () => {
  let fail!: (error: Error) => void;
  io.invoke.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { AuthProvider } = await import("../auth-context");
  const { markSignedIn } = await import("../auth-store");
  const { getAuthAccessToken } = await import("../auth-token");
  renderToStaticMarkup(createElement(AuthProvider, null, "shell"));
  expect(io.effects).toHaveLength(1);
  const off = io.effects[0]!();
  try {
    markSignedIn({ sub: "account-b", email: "b@example.test", name: null, access_token: "fixture-b" });
    fail(new Error("Earlier IPC failed"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getAuthAccessToken()).toBe("fixture-b");
  } finally { off?.(); }
});
