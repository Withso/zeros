import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCloudAgentRunner } from "../cloud-agent-runner.mjs";

describe("one-use native runner entry", () => {
  it("exits with the provider while the engine still holds stdin open", async () => {
    const module = pathToFileURL(path.resolve("apps/desktop/src/engine/agents/containment/cloud-agent-runner.mjs")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {runCloudAgentRunner} from ${JSON.stringify(module)};
      runCloudAgentRunner({input:process.stdin,output:process.stdout,error:process.stderr,proof:{}})
        .then(code=>{process.exitCode=code},()=>{process.exitCode=70});
    `], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, stdio: "pipe" });
    let output = "", errors = "", timer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", bytes => { output += bytes.toString(); });
    child.stderr.on("data", bytes => { errors += bytes.toString(); });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    const deadline = new Promise<"deadline"> (resolve => { timer = setTimeout(() => resolve("deadline"), 3000); });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify({type:"launch", request:{command:process.execPath,
      args:["-e", "process.stdout.write('final provider bytes');process.exitCode=7"], cwd:process.cwd(), env:{}}}) + "\n");
    try {
      expect(await Promise.race([closed, deadline])).toBe(7);
      expect(child.stdin.writableEnded).toBe(false);
      expect(output).toContain("final provider bytes");
      expect(errors).toBe("");
    } finally { clearTimeout(timer); child.kill("SIGKILL"); child.stdin.destroy(); await closed; }
  });
  it("waits for one private request, ACKs its child, and forwards opaque stdio", async () => {
    const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
    const launch = vi.fn(spawn), proof = { opaque: "independently-checked-fixture" };
    let received = ""; output.on("data", chunk => { received += chunk.toString(); });
    const running = runCloudAgentRunner({ input, output, error, proof, spawnProcess: launch });
    expect(launch).not.toHaveBeenCalled();
    expect(JSON.parse(received.trim())).toEqual({ type: "hello", proof });
    input.write(JSON.stringify({ type: "launch", request: { command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({key:process.env.TEST_PRIVATE,cwd:process.cwd()}));process.stdin.pipe(process.stdout)"],
      cwd: process.cwd(), env: { TEST_PRIVATE: "synthetic-private-fixture" } } }) + "\n");
    await expect.poll(() => received.includes('"ack"')).toBe(true);
    input.end("opaque provider input\n");
    expect(await running).toBe(0);
    const lines = received.split("\n");
    expect(JSON.parse(lines[1]!)).toEqual({ type: "ack", proof });
    expect(lines.slice(2).join("\n")).toBe(JSON.stringify({ key: "synthetic-private-fixture", cwd: process.cwd() }) + "opaque provider input\n");
    expect(launch).toHaveBeenCalledOnce();
  });
  it.each([
    { type: "launch", request: { command: "relative", args: [], cwd: "/", env: {} } },
    { type: "launch", request: { command: "/bin/true", args: [], cwd: "/", env: {}, extra: true } },
    { type: "launch", request: { command: "/bin/true", args: [], cwd: "/", env: { "bad=name": "value" } } },
  ])("rejects malformed private material without launching", async value => {
    const input = new PassThrough(), output = new PassThrough(), error = new PassThrough(), launch = vi.fn(spawn);
    const running = runCloudAgentRunner({ input, output, error, proof: {}, spawnProcess: launch });
    const rejected = expect(running).rejects.toThrow("cloud_runner_request_refused");
    input.end(JSON.stringify(value) + "\n"); await rejected;
    expect(launch).not.toHaveBeenCalled();
  });
  it("rejects overlong private frames without invoking any provider", async () => {
    const input = new PassThrough(), output = new PassThrough(), error = new PassThrough(), launch = vi.fn(spawn);
    const running = runCloudAgentRunner({ input, output, error, proof: {}, spawnProcess: launch });
    const rejected = expect(running).rejects.toThrow("cloud_runner_request_refused");
    input.end("x".repeat(65_537)); await rejected;
    expect(launch).not.toHaveBeenCalled();
  });
});
