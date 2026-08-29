import { afterEach, describe, expect, it } from "vitest";

import {
  spawnContainedClaudeProcess,
  terminateContainedClaudeProcess,
  type ContainedClaudeProcess,
} from "../contained-process";

const trackedProcesses: ContainedClaudeProcess[] = [];

afterEach(async () => {
  await Promise.allSettled(
    trackedProcesses.splice(0).map((tracked) =>
      terminateContainedClaudeProcess(tracked, { graceMs: 0 }),
    ),
  );
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")(
  "Claude territory process supervision",
  () => {
    it("kills and verifies a query process group with a live descendant", async () => {
      const abort = new AbortController();
      let tracked: ContainedClaudeProcess | undefined;
      let output = "";
      const child = spawnContainedClaudeProcess(
        {
          command: process.execPath,
          args: [
            "-e",
            `const { spawn } = require("node:child_process");
             const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
             process.stdout.write(String(child.pid) + "\\n");
             setInterval(() => {}, 1000);`,
          ],
          env: process.env,
          signal: abort.signal,
        },
        {
          onSpawn: (value) => {
            tracked = value;
            trackedProcesses.push(value);
          },
          onStderr: () => undefined,
        },
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        output += data;
      });
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("descendant pid was not reported")),
          2_000,
        );
        const poll = () => {
          if (/^\d+\n/.test(output)) {
            clearTimeout(deadline);
            resolve();
          } else {
            setTimeout(poll, 10);
          }
        };
        poll();
      });

      const descendantPid = Number.parseInt(output, 10);
      expect(tracked).toBeDefined();
      await terminateContainedClaudeProcess(tracked!, { graceMs: 0 });
      expect(() => process.kill(descendantPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    });

    it("honors the SDK's forwarded abort signal", async () => {
      const abort = new AbortController();
      let tracked: ContainedClaudeProcess | undefined;
      spawnContainedClaudeProcess(
        {
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          env: process.env,
          signal: abort.signal,
        },
        {
          onSpawn: (value) => {
            tracked = value;
            trackedProcesses.push(value);
          },
          onStderr: () => undefined,
        },
      );
      abort.abort();
      await tracked!.termination;
      expect(tracked!.child.exitCode ?? tracked!.child.signalCode).not.toBeNull();
    });
  },
);
