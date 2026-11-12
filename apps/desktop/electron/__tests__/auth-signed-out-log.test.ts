import { beforeEach, expect, it, vi } from "vitest";
import { logSignedOut, resetSignedOutLogForTests } from "../auth-signed-out-log";

beforeEach(() => { resetSignedOutLogForTests(); });

it("writes one closed-vocabulary line and drops any detail that is not a bounded code or an HTTP status", () => {
  const sink = vi.fn();
  logSignedOut("snapshot_401", { code: "session_revoked", status: 401 }, sink);
  logSignedOut("revoked", { code: "person@example.com", status: 1234 }, sink);
  logSignedOut("revoked", { code: "eyJhbGciOiJSUzI1NiJ9.payload.signature-that-is-long-enough-to-be-a-token-0123456789" }, sink);
  expect(sink.mock.calls.map(([line]) => line)).toEqual([
    "[auth] signed out reason=snapshot_401 code=session_revoked status=401",
    "[auth] signed out reason=revoked",
  ]);
});
