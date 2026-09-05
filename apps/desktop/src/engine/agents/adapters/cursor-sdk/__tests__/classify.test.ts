// Tests for the Cursor SDK adapter's error classifier. The headline case
// is the live bug: @cursor/sdk's Agent.resume throws "Agent <uuid> not
// found" when the persisted agentId is gone (foreign worktree, rotated
// SDK cache, or a pre-SDK cursor-agent CLI chat id). That MUST classify
// as the recoverable `session-expired` kind — not `protocol-error`, which
// the renderer turns into a hard "Agent error" toast on every reopen.

import { describe, it, expect } from "vitest";

import { classifyCursorSdkError, resolveCursorModelId } from "../adapter";
import { AgentFailureError } from "../../../types";

describe("classifyCursorSdkError", () => {
  const missingAgentFixtures = [
    "Agent 896fa66e-4bcc-4786-9571-f042b857cd06 not found",
    "Agent not found",
    "agent does not exist",
    "no such agent",
  ];

  for (const fixture of missingAgentFixtures) {
    it(`classifies "${fixture}" as session-expired on loadSession`, () => {
      const result = classifyCursorSdkError(new Error(fixture), "loadSession");
      expect(result).toBeInstanceOf(AgentFailureError);
      expect(result.failure.kind).toBe("session-expired");
      expect(result.failure.stage).toBe("loadSession");
      expect(result.failure.agentId).toBe("cursor");
    });

    it(`classifies "${fixture}" as session-expired on prompt`, () => {
      const result = classifyCursorSdkError(new Error(fixture), "prompt");
      expect(result.failure.kind).toBe("session-expired");
      expect(result.failure.stage).toBe("prompt");
    });
  }

  it("tailors the loadSession message so the user knows to start fresh", () => {
    const result = classifyCursorSdkError(
      new Error("Agent abc-123 not found"),
      "loadSession",
    );
    expect(result.failure.message).toContain("Start a fresh chat");
  });

  it("classifies auth errors as auth-required", () => {
    for (const msg of [
      "401 Unauthorized",
      "Invalid API key",
      "forbidden: 403",
    ]) {
      const result = classifyCursorSdkError(new Error(msg), "newSession");
      expect(result.failure.kind).toBe("auth-required");
    }
  });

  it("classifies Cursor's typed 429 as a calm rate-limit failure", () => {
    const err = Object.assign(new Error("Too many requests"), {
      name: "RateLimitError",
      status: 429,
      isRetryable: true,
    });
    const result = classifyCursorSdkError(err, "prompt");

    expect(result.failure.kind).toBe("rate-limited");
    expect(result.failure.message).toMatch(/rate.?limit/i);
    expect(result.failure.advice).toMatch(/try again/i);
  });

  it("prefers a typed 429 over network-shaped error wording", () => {
    const err = Object.assign(new Error("ETIMEDOUT while waiting to retry"), {
      name: "RateLimitError",
      status: 429,
    });

    expect(classifyCursorSdkError(err, "prompt").failure.kind).toBe(
      "rate-limited",
    );
  });

  it("recognizes a serialized 429 after it crosses the Cursor host boundary", () => {
    const result = classifyCursorSdkError(
      new Error("429 resource exhausted: rate limit reached"),
      "prompt",
    );
    expect(result.failure.kind).toBe("rate-limited");
  });

  it("falls back to protocol-error for unknown failures", () => {
    const result = classifyCursorSdkError(
      new Error("some unexpected internal failure"),
      "prompt",
    );
    expect(result.failure.kind).toBe("protocol-error");
  });

  it("classifies nullish host errors without throwing its own TypeError", () => {
    for (const value of [null, undefined]) {
      const result = classifyCursorSdkError(value, "prompt");
      expect(result.failure.kind).toBe("protocol-error");
    }
  });

  it("classifies TLS / certificate failures with actionable guidance (HTTPS interception)", () => {
    // This altname error used to fire SPURIOUSLY because the bun runtime
    // mis-parsed Cursor's valid cert under node:http2 — that path now runs in
    // the Node host (see host/cursor-host.cjs), so reaching the classifier with
    // this string now means GENUINE HTTPS interception, which the message
    // explains. The classifier behaviour is unchanged either way.
    const result = classifyCursorSdkError(
      new Error(
        "[internal] Hostname/IP does not match certificate's altnames: Cert does not contain a DNS name",
      ),
      "prompt",
    );
    expect(result.failure.kind).toBe("protocol-error");
    // The pill must explain it's a network/proxy issue, not model/auth.
    expect(result.failure.message).toMatch(
      /TLS|secure connection|HTTPS-inspecting/i,
    );
    expect(result.failure.message).toMatch(/cursor\.sh|NODE_EXTRA_CA_CERTS/i);
  });

  it("classifies other TLS chain errors too", () => {
    for (const msg of [
      "self-signed certificate in certificate chain",
      "unable to verify the first certificate",
      "unable to get local issuer certificate",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ]) {
      const result = classifyCursorSdkError(new Error(msg), "prompt");
      expect(result.failure.kind).toBe("protocol-error");
      expect(result.failure.message).toMatch(/secure|TLS|HTTPS/i);
    }
  });

  it("classifies transient network errors as transport-closed (recoverable, silent retry)", () => {
    for (const msg of [
      "ECONNREFUSED 127.0.0.1:9000",
      "ECONNRESET",
      "getaddrinfo ENOTFOUND api2.cursor.sh",
      "socket hang up",
      "ETIMEDOUT",
    ]) {
      const result = classifyCursorSdkError(new Error(msg), "prompt");
      expect(result.failure.kind).toBe("transport-closed");
    }
  });

  it("routes an UNEXPECTED host death (code CURSOR_HOST_EXITED) → transport-closed", () => {
    // host-client.onExit tags a crash/kill of the Node host with this code —
    // the host respawns on the next call, so recovery is a silent retry, not
    // a hard error toast. Keyed on the explicit code, never message wording.
    const err = new Error(
      "cursor host: the Cursor SDK host (Node subprocess) exited unexpectedly",
    ) as Error & { code?: string };
    err.code = "CURSOR_HOST_EXITED";
    const result = classifyCursorSdkError(err, "prompt");
    expect(result.failure.kind).toBe("transport-closed");
    expect(result.failure.message).toMatch(/respawns/i);
  });

  it("routes a crash-looping host (code CURSOR_HOST_CRASH_LOOP) → terminal protocol-error WITH user-facing advice", () => {
    // The toast layer suppresses technical `message` detail (UI-indication
    // consolidation 2026-07-10); `failure.advice` is the carve-out that
    // carries the fix instructions to the user.
    const err = new Error(
      "cursor host: the Cursor SDK host (Node subprocess) exited unexpectedly " +
        "— and has now crashed 3 times in a row at boot.",
    ) as Error & { code?: string };
    err.code = "CURSOR_HOST_CRASH_LOOP";
    const result = classifyCursorSdkError(err, "prompt");
    expect(result.failure.kind).toBe("protocol-error");
    expect(result.failure.advice).toMatch(/ZEROS_PTY_HOST_RUNTIME/);
    expect(result.failure.advice).toMatch(/engine log/i);
  });

  it("keeps a true spawn failure TERMINAL (no tag) — respawn would fail identically", () => {
    const result = classifyCursorSdkError(
      new Error(
        "cursor host: couldn't start the Cursor SDK host (Node subprocess). " +
          "Cursor needs a Node runtime because the engine's bun runtime can't " +
          "establish the SDK's HTTP/2 connection.",
      ),
      "prompt",
    );
    expect(result.failure.kind).toBe("protocol-error");
  });

  it("does NOT mistake a missing-binary message for a missing agent", () => {
    // The ENOENT spawn path produces "<cmd> CLI is not installed ..." — it
    // contains neither "agent … not found" nor "no such agent", so it must
    // stay a protocol-error rather than silently self-healing.
    const result = classifyCursorSdkError(
      new Error("cursor-agent CLI is not installed or not on $PATH"),
      "newSession",
    );
    expect(result.failure.kind).not.toBe("session-expired");
  });
});

describe("resolveCursorModelId (local SDK needs an explicit model)", () => {
  it("preserves Cursor's Auto/Router ids and only defaults an absent pick", () => {
    expect(resolveCursorModelId("auto")).toBe("auto");
    expect(resolveCursorModelId("default")).toBe("default");
    expect(resolveCursorModelId("AUTO")).toBe("auto");
    expect(resolveCursorModelId("Default")).toBe("default");
    for (const absent of ["", "  "]) {
      expect(resolveCursorModelId(absent)).toBe("composer-2.5");
    }
    expect(resolveCursorModelId(undefined)).toBe("composer-2.5");
  });

  it("passes a concrete model id through untouched", () => {
    expect(resolveCursorModelId("composer-2")).toBe("composer-2");
    expect(resolveCursorModelId("  gpt-5.3-codex  ")).toBe("gpt-5.3-codex");
  });
});
