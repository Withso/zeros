import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

const supervisor = path.resolve("scripts/dev-main-supervisor.mjs");
const fixtures: Array<{ root: string; child: ChildProcess }> = [];

afterEach(async () => {
  for (const { root, child } of fixtures.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(busy: boolean, responds = true) {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-main-hmr-"));
  await mkdir(path.join(root, "dist-electron"));
  const output = path.join(root, "dist-electron", "main.cjs");
  await writeFile(output, "initial");
  await writeFile(path.join(root, "dist-electron", "preload.cjs"), "initial");
  const marker = path.join(root, "busy");
  await writeFile(marker, busy ? "1" : "0");
  const trace = path.join(root, "trace.jsonl");
  const app = path.join(root, "fake-electron.mjs");
  await writeFile(
    app,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const record = (event) => appendFileSync(process.env.HMR_TEST_TRACE, JSON.stringify({event, pid:process.pid}) + "\\n");
record("launch");
process.on("SIGTERM", () => { record("terminate"); process.exit(0); });
process.on("message", (message) => {
  if (${responds} && message?.type === "zeros:dev-main-restart-check") {
    process.send({type:"zeros:dev-main-restart-status", requestId:message.requestId, busy:readFileSync(process.env.HMR_TEST_BUSY, "utf8") === "1"});
  }
});
setInterval(() => {}, 1000);
`,
  );
  await chmod(app, 0o755);
  const child = spawn(process.execPath, [supervisor, app], {
    cwd: root,
    env: { ...process.env, HMR_TEST_TRACE: trace, HMR_TEST_BUSY: marker },
    stdio: ["ignore", "pipe", "pipe"],
  });
  fixtures.push({ root, child });
  let logs = "";
  child.stdout!.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    logs += String(chunk);
  });
  const events = async () => {
    try {
      return (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; pid: number });
    } catch {
      return [];
    }
  };
  await expect.poll(async () => (await events()).length).toBe(1);
  return { child, output, marker, events, logs: () => logs };
}

describe("development main-process restart", () => {
  it("keeps the running app while clean rebuild outputs are missing", async () => {
    const app = await fixture(false);
    const preload = path.join(path.dirname(app.output), "preload.cjs");
    await rm(preload);
    await writeFile(app.output, "next main");
    await delay(900);
    const beforeBuildCompleted = await app.events();
    await writeFile(preload, "next preload");
    await expect
      .poll(async () => (await app.events()).length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(3);
    expect(beforeBuildCompleted).toHaveLength(1);
  });

  it("ignores rebuilds whose runtime outputs have not changed", async () => {
    const app = await fixture(false);
    await writeFile(app.output, "initial");
    await delay(900);
    expect(await app.events()).toHaveLength(1);
  });

  it("keeps the active app alive across rebuilds and restarts once it becomes idle", async () => {
    const app = await fixture(true);
    await writeFile(app.output, "updated");
    await delay(900);
    expect(await app.events()).toHaveLength(1);
    await writeFile(app.output, "newer update");
    await delay(700);
    expect(await app.events()).toHaveLength(1);
    await writeFile(app.marker, "0");
    await expect
      .poll(async () => (await app.events()).map((item) => item.event), {
        timeout: 5000,
      })
      .toEqual(["launch", "terminate", "launch"]);
    expect(app.logs()).not.toContain("SIGKILL");
  });

  it("does not kill an app whose restart readiness cannot be established", async () => {
    const app = await fixture(false, false);
    await writeFile(app.output, "updated");
    await delay(2700);
    expect(await app.events()).toHaveLength(1);
    expect(app.child.exitCode).toBeNull();
  });

  it("respects an explicit app quit while a rebuild is waiting", async () => {
    const app = await fixture(true);
    await writeFile(app.output, "updated");
    await delay(700);
    const exited = once(app.child, "exit");
    process.kill((await app.events())[0]!.pid, "SIGTERM");
    await exited;
    expect((await app.events()).map((item) => item.event)).toEqual([
      "launch",
      "terminate",
    ]);
  });
});
