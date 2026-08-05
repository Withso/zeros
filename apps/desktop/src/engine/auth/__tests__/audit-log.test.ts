import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendSecurityAudit, readSecurityAudit } from "../audit-log";

describe("security audit log (M2)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-audit-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends events as JSONL and reads them back oldest→newest with a timestamp", () => {
    appendSecurityAudit({ type: "device-paired", deviceId: "PUBKEYAAA", label: "Phone" }, dir);
    appendSecurityAudit({ type: "account-bound", clientId: "c1", accountSub: "sub-123" }, dir);
    appendSecurityAudit({ type: "device-revoked", deviceId: "PUBKEYAAA" }, dir);

    const events = readSecurityAudit(200, dir);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("device-paired");
    expect(events[2].type).toBe("device-revoked");
    expect(typeof events[0].ts).toBe("string");

    // On disk it's valid JSONL — one parseable object per line.
    const raw = fs.readFileSync(path.join(dir, "security-audit.jsonl"), "utf-8").trim();
    const lines = raw.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("records ONLY the declared fields + ts (no token-like material)", () => {
    appendSecurityAudit(
      { type: "account-rejected", clientId: "c2", reason: "auth-wrong-account" },
      dir,
    );
    const [e] = readSecurityAudit(1, dir);
    expect(Object.keys(e).sort()).toEqual(["clientId", "reason", "ts", "type"]);
  });

  it("is best-effort: an unwritable target never throws", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x"); // a FILE where a dir would be needed
    expect(() =>
      appendSecurityAudit({ type: "server-rotated" }, path.join(blocker, "nested")),
    ).not.toThrow();
  });

  it("returns [] when no log exists yet", () => {
    expect(readSecurityAudit(200, path.join(dir, "does-not-exist"))).toEqual([]);
  });
});
