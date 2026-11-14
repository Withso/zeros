import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { CloudTeamEvents } from "./events.js";
import type { TeamAdmission } from "./authority.js";
import type { CloudTeamSharing } from "./store.js";
import type { CloudTeamSignals, TeamHint } from "./signals.js";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers(); vi.restoreAllMocks();
});

async function open() {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const user = { id: "viewer", authentication: { sessionId: "session", tokenExpiresAt: Date.now()/1000+3600 } } as AuthedUser;
  const proof = { user, view: { workspace: { id: workspaceId } }, source: null } as TeamAdmission;
  const authority = { admit: vi.fn(async () => proof), assert: vi.fn(async () => proof.view) };
  let notify = (_hint: TeamHint) => {};
  const signals = { subscribe: (_id: string, listener: typeof notify) => { notify = listener; return () => {}; },
    start: async () => {}, healthy: () => true };
  const events = new CloudTeamEvents({ authority } as unknown as CloudTeamSharing, signals as unknown as CloudTeamSignals);
  vi.spyOn(events.presence, "open").mockResolvedValue("connection");
  vi.spyOn(events.presence, "close").mockResolvedValue();
  const renew = vi.spyOn(events.presence, "renew").mockResolvedValue();
  const snapshot = vi.spyOn(events.presence, "snapshot").mockResolvedValue({ workspaceId, userIds: [user.id], total: 1 });
  const app = new Hono();
  app.get("/events", c => { c.set("user", user); return events.open(c, workspaceId); });
  const controller = new AbortController();
  const response = await app.request("/events", { signal: controller.signal });
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let output = "";
  const pump = (async () => { for (;;) { const next = await reader.read(); if (next.done) return; output += decoder.decode(next.value); } })();
  cleanups.push(async () => { controller.abort(); await reader.cancel(); await pump; });
  await vi.advanceTimersByTimeAsync(0);
  expect(output).toContain("event: ready");
  return { authority, renew, snapshot, notify: (hint: TeamHint) => notify(hint), output: () => output };
}

it("does no idle authority, presence or renewal reads before the sixty-second fallback", async () => {
  const f = await open();
  f.authority.assert.mockClear(); f.snapshot.mockClear();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(f.authority.assert).not.toHaveBeenCalled();
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.renew).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.authority.assert).toHaveBeenCalledOnce();
  expect(f.snapshot).toHaveBeenCalledOnce();
  expect(f.renew).toHaveBeenCalledOnce();
});

it("checks a content hint immediately even when the removal notice was lost", async () => {
  const f = await open();
  f.authority.assert.mockRejectedValue(new HttpError(404, "not_found", "Unavailable"));
  await vi.advanceTimersByTimeAsync(1);
  f.notify("changed");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.output()).toContain("event: revoked");
  expect(f.output()).not.toContain("event: changed");
});

it("checks a known revocation immediately during an idle interval", async () => {
  const f = await open();
  f.authority.assert.mockRejectedValue(new HttpError(401, "session_revoked", "Unavailable"));
  f.notify("authority");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.output()).toContain('"code":"session_revoked"');
});
