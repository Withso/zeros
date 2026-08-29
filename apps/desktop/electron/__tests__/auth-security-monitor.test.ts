import { describe, expect, it, vi } from "vitest";

import {
  WorkOSDesktopSecurityMonitor,
  consumeSecurityEventStream,
  desktopSecurityEventAction,
} from "../auth-security-monitor";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("desktop WorkOS security lifecycle", () => {
  it("parses bounded SSE frames across arbitrary transport chunks", async () => {
    const frames: Array<{ event: string; id: string | null; data: string }> = [];
    await consumeSecurityEventStream(
      stream([
        "event: ready\nda",
        "ta: {\"cursor\":4}\n\nid: 5\nevent: organization.access_",
        "revoked\ndata: {\"sequence\":5,\"organizationId\":\"org-a\"}\n\n",
      ]),
      (frame) => {
        frames.push(frame);
      },
    );
    expect(frames).toEqual([
      { event: "ready", id: null, data: '{"cursor":4}' },
      {
        event: "organization.access_revoked",
        id: "5",
        data: '{"sequence":5,"organizationId":"org-a"}',
      },
    ]);
  });

  it("rejects an oversized SSE event instead of buffering it", async () => {
    await expect(
      consumeSecurityEventStream(
        stream([`event: organization.data_changed\ndata: ${"x".repeat(65 * 1024)}\n\n`]),
        () => undefined,
      ),
    ).rejects.toThrow(/exceeded its bound/);
  });

  it("treats account/session revocation as terminal and organization changes as refreshes", () => {
    expect(desktopSecurityEventAction("account.revoked")).toBe("sign_out");
    expect(desktopSecurityEventAction("session.revoked")).toBe("sign_out");
    expect(
      desktopSecurityEventAction("organization.authorization_changed"),
    ).toBe("refresh");
    expect(desktopSecurityEventAction("heartbeat")).toBe("none");
  });

  it("clears only the captured WorkOS session on a definitive snapshot rejection", async () => {
    const clear = vi.fn(() => true);
    const emit = vi.fn();
    const monitor = new WorkOSDesktopSecurityMonitor({
      baseUrl: "https://api-alpha.zeros.build",
      getSession: async () => ({
        provider: "workos",
        accessToken: "access",
        accountId: "00000000-0000-4000-8000-000000000001",
        sessionId: "session_example",
      }),
      clearSession: clear,
      emit,
      fetch: vi.fn(async () =>
        Response.json({ error: { code: "session_revoked" } }, { status: 401 }),
      ) as unknown as typeof fetch,
      connectStreams: false,
    });

    await expect(monitor.revalidate("launch", true)).resolves.toBe("signed_out");
    expect(clear).toHaveBeenCalledWith({
      accountId: "00000000-0000-4000-8000-000000000001",
      sessionId: "session_example",
    });
    expect(emit).toHaveBeenCalledWith("auth-security-revoked", {
      reason: "session_revoked",
    });
  });

  it("retains the session across network and server outages", async () => {
    const clear = vi.fn(() => true);
    const session = {
      provider: "workos" as const,
      accessToken: "access",
      accountId: "00000000-0000-4000-8000-000000000001",
      sessionId: "session_example",
    };
    const unavailable = new WorkOSDesktopSecurityMonitor({
      baseUrl: "https://api-alpha.zeros.build",
      getSession: async () => session,
      clearSession: clear,
      emit: vi.fn(),
      fetch: vi.fn(async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      connectStreams: false,
    });
    await expect(unavailable.revalidate("resume", true)).resolves.toBe(
      "transient",
    );
    expect(clear).not.toHaveBeenCalled();

    const serverError = new WorkOSDesktopSecurityMonitor({
      baseUrl: "https://api-alpha.zeros.build",
      getSession: async () => session,
      clearSession: clear,
      emit: vi.fn(),
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
      connectStreams: false,
    });
    await expect(serverError.revalidate("focus", true)).resolves.toBe(
      "transient",
    );
    expect(clear).not.toHaveBeenCalled();
  });

  it("keeps the snapshot timeout active while a response body is stalled", async () => {
    vi.useFakeTimers();
    try {
      const monitor = new WorkOSDesktopSecurityMonitor({
        baseUrl: "https://api-alpha.zeros.build",
        getSession: async () => ({
          provider: "workos",
          accessToken: "access",
          accountId: "00000000-0000-4000-8000-000000000001",
          sessionId: "session_example",
        }),
        clearSession: vi.fn(() => true),
        emit: vi.fn(),
        fetch: vi.fn(async (_url, init) => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => {
                controller.error(new Error("aborted"));
              });
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
        connectStreams: false,
      });
      const outcome = monitor.revalidate("launch", true);

      await vi.advanceTimersByTimeAsync(10_001);
      await expect(outcome).resolves.toBe("transient");
    } finally {
      vi.useRealTimers();
    }
  });
});
