import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  directory: "",
  user: null as { accountId: string; sub: string; provider: "workos"; sessionId: string } | null,
  listeners: [] as Array<() => void>,
  token: vi.fn(async () => "access-token"),
  capability: true,
  sent: [] as Array<{ id: string; operation: string }>,
  timers: [] as Array<{ delayMs: number; run: () => void }>,
  failWith: null as null | { status?: number; code?: string; networkError?: boolean },
}));
vi.mock("electron", () => ({ app: { getPath: () => h.directory } }));
vi.mock("../ipc/commands/auth-session", () => ({
  getSessionUserForMain: () => h.user,
  onMainAuthSessionChanged: (fn: () => void) => {
    h.listeners.push(fn);
    return () => {};
  },
  getValidAccessTokenForMain: h.token,
}));
vi.mock("../../src/engine/cloud-workspace-capability", () => ({
  cloudWorkspaceDesktopCapabilityEnabled: () => h.capability,
}));

import {
  __setCloudOutboxSenderForTests,
  cloudWorkspaceOutboxEnqueue,
  cloudWorkspaceOutboxList,
  installCloudOutboxLifecycle,
} from "../ipc/commands/cloud-outbox";

const ORGANIZATION = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const event = {} as never;

const userA = { accountId: "account-a", sub: "workos-a", provider: "workos" as const, sessionId: "session-a" };
const userB = { accountId: "account-b", sub: "workos-b", provider: "workos" as const, sessionId: "session-b" };

function signIn(user: typeof userA | null) {
  h.user = user;
  for (const listener of h.listeners) listener();
}

beforeEach(async () => {
  h.directory = await mkdtemp(path.join(tmpdir(), "zeros-outbox-ipc-"));
  h.user = { ...userA };
  // h.listeners persists: installCloudOutboxLifecycle registers once per process.
  h.sent.length = 0;
  h.timers.length = 0;
  h.failWith = null;
  h.capability = true;
  __setCloudOutboxSenderForTests(
    async (entry) => {
      if (h.failWith)
        throw Object.assign(new Error(h.failWith.code ?? "send failed"), { ...h.failWith });
      h.sent.push({ id: entry.id, operation: entry.operation });
      return { status: 202, replayed: false };
    },
    (delayMs, run) => {
      h.timers.push({ delayMs, run });
    },
  );
  installCloudOutboxLifecycle();
});

afterEach(async () => {
  __setCloudOutboxSenderForTests(null);
  await rm(h.directory, { recursive: true, force: true });
});

describe("cloud workspace outbox IPC", () => {
  it("enqueues a lifecycle command and drains it with its stable id", async () => {
    const entry = cloudWorkspaceOutboxEnqueue(
      { operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE },
      event,
    ) as { id: string; state: string };
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/u);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toEqual({ id: entry.id, operation: "wake" });
    const listed = cloudWorkspaceOutboxList({}, event) as Array<{ id: string; state: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: entry.id, state: "completed" });
  });

  it("validates the command shape before touching the outbox", () => {
    expect(() => cloudWorkspaceOutboxEnqueue({ operation: "explode", organizationId: ORGANIZATION }, event)).toThrow();
    expect(() =>
      cloudWorkspaceOutboxEnqueue({ operation: "rename", organizationId: ORGANIZATION, workspaceId: WORKSPACE }, event),
    ).toThrow(/name/);
    expect(() => cloudWorkspaceOutboxEnqueue({ operation: "wake", organizationId: ORGANIZATION }, event)).toThrow(/workspaceId/);
  });

  it("requires a signed-in account", () => {
    h.user = null;
    expect(() =>
      cloudWorkspaceOutboxEnqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE }, event),
    ).toThrow(/signed-in/);
  });

  it("never constructs the outbox when the desktop capability is off", async () => {
    h.capability = false;
    expect(() =>
      cloudWorkspaceOutboxEnqueue({ operation: "wake", organizationId: ORGANIZATION, workspaceId: WORKSPACE }, event),
    ).toThrow(/disabled/);
    await expect(readdir(path.join(h.directory, "cloud-outbox-v1"))).rejects.toThrow();
  });

  it("clears the account's outbox on sign-out and on switching away", async () => {
    h.failWith = { status: 503 };
    cloudWorkspaceOutboxEnqueue({ operation: "stop", organizationId: ORGANIZATION, workspaceId: WORKSPACE }, event);
    await vi.waitFor(() => {
      const listed = cloudWorkspaceOutboxList({}, event) as Array<{ attempts: number }>;
      expect(listed[0]!.attempts).toBe(1);
    });
    // Sign out: A's outbox is wiped, nothing pending survives.
    signIn(null);
    signIn({ ...userA });
    expect(cloudWorkspaceOutboxList({}, event)).toHaveLength(0);
    // Switch A to B: B never sees or sends A's commands.
    h.failWith = { status: 503 };
    cloudWorkspaceOutboxEnqueue({ operation: "archive", organizationId: ORGANIZATION, workspaceId: WORKSPACE }, event);
    await vi.waitFor(() => {
      const listed = cloudWorkspaceOutboxList({}, event) as Array<{ attempts: number }>;
      expect(listed[0]!.attempts).toBe(1);
    });
    const sentBefore = h.sent.length;
    signIn({ ...userB });
    expect(cloudWorkspaceOutboxList({}, event)).toHaveLength(0);
    expect(h.sent.length).toBe(sentBefore);
  });
});
