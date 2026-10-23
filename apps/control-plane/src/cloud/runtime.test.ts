import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installRuntimeCommand } from "./runtime.js";

const sha256 = "a".repeat(64);
const url = "https://r2.example.test/bucket/cloud-v2/runtime/aaa.tar.gz?X-Amz-Signature=abc&X-Amz-Expires=900";

describe("cloud v2 runtime install", () => {
  it("downloads a missing runtime once, checks its sha256 and points the worker at it", () => {
    const command = installRuntimeCommand({ sha256, url });
    expect(command.startsWith("bash -c '")).toBe(true);
    // The script is one quoted argument that bash parses cleanly.
    execFileSync("bash", ["-c", `set -- ${command.slice("bash -c ".length)}; bash -n -c "$1"`]);
    const script = execFileSync("bash", ["-c", `set -- ${command.slice("bash -c ".length)}; printf %s "$1"`], { encoding: "utf8" });
    expect(script).toContain(`dir=/opt/zeros/runtime/${sha256}`);
    expect(script).toContain('if [ ! -f "$dir/.complete" ]');
    expect(script).toContain(`printf '%s  %s\\n' ${sha256} "$tmp/runtime.tar.gz" | sha256sum -c --status`);
    expect(script).toContain(`'${url}'`);
    expect(script).toContain("sudo -n mv -T /opt/zeros/worker.next /opt/zeros/worker");
    expect(script).toContain("systemctl try-restart zeros-worker.service");
  });

  it("refuses a malformed version or a non-https source", () => {
    expect(() => installRuntimeCommand({ sha256: "abc", url })).toThrow();
    expect(() => installRuntimeCommand({ sha256, url: "http://r2.example.test/x" })).toThrow();
    expect(() => installRuntimeCommand({ sha256, url: "https://user:pw@r2.example.test/x" })).toThrow();
  });
});
