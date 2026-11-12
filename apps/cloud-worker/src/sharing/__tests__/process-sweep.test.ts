import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { sweepContext } from "../process-sweep";

const A = "66666666-6666-4666-8666-666666666666", B = "77777777-7777-4777-8777-777777777777";
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });
const start = (contextId: string, script = "sleep 30") => {
  const child = spawn("/bin/sh", ["-c", script], { env: { PATH: process.env.PATH, ZEROS_EXECUTION_CONTEXT: contextId }, stdio: "ignore" });
  children.push(child);
  return new Promise<ChildProcess>(resolve => child.once("spawn", () => resolve(child)));
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it.skipIf(process.platform !== "linux")("kills every process of one context, its descendants included, and leaves other contexts alone", async () => {
  const shell = await start(A, "sleep 30 & sleep 30 & wait");
  const other = await start(B);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await sweepContext(A)).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(alive(shell.pid!)).toBe(false);
  expect(alive(other.pid!)).toBe(true);
});

it("counts what it could not end, and never touches itself", async () => {
  const environ = new Map<number, string>([[10, `PATH=/bin\0ZEROS_EXECUTION_CONTEXT=${A}\0`], [11, `ZEROS_EXECUTION_CONTEXT=${A}\0`], [12, `ZEROS_EXECUTION_CONTEXT=${A}x\0`], [99, `ZEROS_EXECUTION_CONTEXT=${A}\0`]]);
  const killed: number[] = [];
  const remaining = await sweepContext(A, { self: 99, waitMs: 20, intervalMs: 5,
    pids: async () => [...environ.keys()], environ: async pid => environ.get(pid) ?? "",
    kill: pid => { killed.push(pid); if (pid === 10) environ.delete(10); } });
  expect(killed.sort()).toEqual(expect.arrayContaining([10, 11]));
  expect(killed).not.toContain(12); expect(killed).not.toContain(99);
  expect(remaining).toBe(1);
});
