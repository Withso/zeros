import { afterEach, describe, expect, it } from "vitest";

import type { PreparedBoundary } from "../../../containment/types";
import { spawnStdioAgent, type StdioAgentProcess } from "../stdio-process";

const processes: StdioAgentProcess[] = [];

afterEach(async () => {
  await Promise.allSettled(
    processes
      .splice(0)
      .map((agent) => agent.stop({ gracefulMs: 0, forceMs: 1_000 })),
  );
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")(
  "stdio agent process supervision",
  () => {
    it("treats a supplied environment as complete and cannot reintroduce an engine secret", async () => {
      const key = "ZEROS_LOCAL_WS_TOKEN";
      const previous = process.env[key];
      process.env[key] = "engine-secret-that-must-not-cross";
      try {
        const agent = spawnStdioAgent({
          command: process.execPath,
          args: [
            "-e",
            `process.stdout.write(JSON.stringify({
              safe: process.env.ZEROS_SAFE_ONLY,
              leaked: process.env.${key} ?? null,
            }));`,
          ],
          cwd: process.cwd(),
          env: { ZEROS_SAFE_ONLY: "visible" },
        });
        processes.push(agent);
        agent.child.stdout?.setEncoding("utf8");
        let output = "";
        agent.child.stdout?.on("data", (data: string) => {
          output += data;
        });

        await expect(agent.exited).resolves.toEqual({ code: 0, signal: null });
        expect(JSON.parse(output)).toEqual({ safe: "visible", leaked: null });
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    });

    it("proves the complete group dead even when the direct wrapper exits", async () => {
      const agent = spawnStdioAgent({
        command: process.execPath,
        args: [
          "-e",
          `const { spawn } = require("node:child_process");
           const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
           child.unref();
           process.stdout.write(String(child.pid) + "\\n");`,
        ],
        cwd: process.cwd(),
      });
      processes.push(agent);
      agent.child.stdout?.setEncoding("utf8");
      let output = "";
      agent.child.stdout?.on("data", (data: string) => {
        output += data;
      });
      await agent.exited;
      expect(agent.child.exitCode).toBe(0);
      const descendantPid = Number.parseInt(output, 10);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);

      await agent.stop({ gracefulMs: 0, forceMs: 1_000 });
      expect(() => process.kill(descendantPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    });

    it("is idempotent across concurrent stops", async () => {
      const agent = spawnStdioAgent({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
      });
      processes.push(agent);
      const first = agent.stop({ gracefulMs: 0 });
      const second = agent.stop({ gracefulMs: 0 });
      expect(second).toBe(first);
      await expect(first).resolves.toBeUndefined();
    });

    it("settles supervision when the executable disappears before spawn", async () => {
      const agent = spawnStdioAgent({
        command: `/definitely/missing/zeros-stdio-${process.pid}`,
        args: [],
        cwd: process.cwd(),
      });
      processes.push(agent);
      const spawnError = new Promise<Error>((resolve) => {
        agent.child.once("error", resolve);
      });

      await expect(spawnError).resolves.toMatchObject({ code: "ENOENT" });
      await expect(
        Promise.race([
          agent.exited,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("spawn failure did not settle")),
              1_000,
            ),
          ),
        ]),
      ).resolves.toMatchObject({ code: null, signal: null });
      await expect(
        agent.stop({ gracefulMs: 0, forceMs: 100 }),
      ).resolves.toBeUndefined();
    });

    it("installs the permanent child error listener before boundary registration", async () => {
      let errorListenersAtRegistration = 0;
      const boundary = {
        wrapSpawn: (request: Record<string, unknown>) => request,
        trackProcess: (child: { listenerCount(name: string): number }) => {
          errorListenersAtRegistration = child.listenerCount("error");
          return { stopAndProve: async () => undefined };
        },
      } as unknown as PreparedBoundary;
      const agent = spawnStdioAgent({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        executionBoundary: boundary,
      });
      processes.push(agent);

      await agent.exited;
      expect(errorListenersAtRegistration).toBeGreaterThan(0);
    });
  },
);
