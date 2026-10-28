import { expect, it } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

it("writes boot diagnostics into a fresh private directory without following a planted legacy link", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-boot-test-"));
  try {
    const outside = path.join(root, "outside"); fs.writeFileSync(outside, "canary");
    fs.symlinkSync(outside, path.join(root, "zeros-boot.log"));
    const processStub = Object.assign(new EventEmitter(), { type: "browser", getuid: process.getuid?.bind(process) });
    const source = fs.readFileSync(new URL("../boot-trace.cjs", import.meta.url), "utf8");
    runInNewContext(source, { process: processStub, require: (name: string) => name === "node:fs" ? fs : name === "node:path" ? path : { ...os, tmpdir: () => root } });
    processStub.emit("uncaughtExceptionMonitor", new Error("synthetic confidential message"));
    const directory = fs.readdirSync(root).find(name => name.startsWith("zeros-boot-") && fs.statSync(path.join(root, name)).isDirectory())!;
    const log = path.join(root, directory, "boot.log");
    expect(fs.statSync(path.dirname(log)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(outside, "utf8")).toBe("canary");
    expect(fs.readFileSync(log, "utf8")).not.toContain("synthetic confidential message");
    processStub.emit("exit");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
