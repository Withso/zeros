import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  AUDIT_ATTEMPTS,
  isRetryableAuditTransportFailure,
  runAuditWithRetries,
} from "../check-audit.mjs";

describe("root production audit retries", () => {
  it("routes the root audit check through the bounded wrapper", () => {
    const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(rootPackage.scripts["check:audit"]).toBe(
      "node scripts/check-audit.mjs",
    );
  });

  it("recognizes only the reviewed registry transport failures", () => {
    for (const output of [
      "npm error code ERR_SOCKET_TIMEOUT",
      "request failed: ECONNRESET",
      "request ETIMEDOUT",
      "getaddrinfo EAI_AGAIN registry.npmjs.org",
      "HTTP 408 Request Timeout",
      "HTTP 429 Too Many Requests",
      "HTTP 500 Internal Server Error",
      "HTTP 503 Service Unavailable",
    ]) {
      expect(isRetryableAuditTransportFailure(output)).toBe(true);
    }

    for (const output of [
      "found 1 high severity vulnerability",
      "GHSA-vrm6-8vpv-qv8q",
      "HTTP 400 Bad Request",
      "audit command timed out after 60000ms",
      "network unavailable",
    ]) {
      expect(isRetryableAuditTransportFailure(output)).toBe(false);
    }
  });

  it("retries a recognized transport failure and preserves the later success", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, output: "ERR_SOCKET_TIMEOUT" })
      .mockResolvedValueOnce({ exitCode: 0, output: "found 0 vulnerabilities" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runAuditWithRetries({ execute, sleep });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(result).toEqual({
      exitCode: 0,
      output: "found 0 vulnerabilities",
    });
  });

  it("immediately preserves an advisory or other non-transport failure", async () => {
    const advisory = {
      exitCode: 1,
      output: "found 1 high severity vulnerability",
    };
    const execute = vi.fn().mockResolvedValue(advisory);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(runAuditWithRetries({ execute, sleep })).resolves.toBe(advisory);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns the final recognized transport failure after the bounded retry budget", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 1,
      output: "HTTP 503 Service Unavailable",
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runAuditWithRetries({ execute, sleep });

    expect(execute).toHaveBeenCalledTimes(AUDIT_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(AUDIT_ATTEMPTS - 1);
    expect(result).toEqual({
      exitCode: 1,
      output: "HTTP 503 Service Unavailable",
    });
  });

  it("does not retry a whole-command timeout", async () => {
    const timeout = {
      exitCode: 1,
      output: "audit command timed out after 60000ms",
      timedOut: true,
    };
    const execute = vi.fn().mockResolvedValue(timeout);

    await expect(runAuditWithRetries({ execute })).resolves.toBe(timeout);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries a bounded command only when its output identifies a transport failure", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        output: "ERR_SOCKET_TIMEOUT\naudit command timed out after 150000ms",
        timedOut: true,
      })
      .mockResolvedValueOnce({ exitCode: 0, output: "found 0 vulnerabilities" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(runAuditWithRetries({ execute, sleep })).resolves.toEqual({
      exitCode: 0,
      output: "found 0 vulnerabilities",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("stops retrying when the total audit budget is exhausted", async () => {
    let clock = 0;
    const transportFailure = { exitCode: 1, output: "ETIMEDOUT" };
    const execute = vi.fn(async () => {
      clock += 600;
      return transportFailure;
    });
    const sleep = vi.fn(async (milliseconds: number) => {
      clock += milliseconds;
    });

    await expect(
      runAuditWithRetries({
        execute,
        sleep,
        now: () => clock,
        attemptTimeoutMs: 1_000,
        totalTimeoutMs: 700,
      }),
    ).resolves.toBe(transportFailure);
    expect(execute).toHaveBeenCalledWith({ timeoutMs: 700 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
  });
});
