import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

it.skipIf(process.platform === "win32")("refuses an operator FIFO without waiting for a writer or connecting to a database", () => {
  const directory = mkdtempSync(join(tmpdir(), "execution-operator-")); roots.push(directory);
  const file = join(directory, "change"), fifo = join(directory, "pipe");
  writeFileSync(file, "{}");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  const run = (path: string) => spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./manage-cloud-execution.ts", import.meta.url))], {
    encoding: "utf8", timeout: 5_000,
    env: { ...process.env, CLOUD_EXECUTION_CHANGE_FILE: path, CONTROL_PLANE_EXECUTION_CHANNEL: "development",
      RAILWAY_ENVIRONMENT_NAME: "development", DATABASE_URL: "postgresql://postgres@127.0.0.1:1/fixture_execution" },
  });
  const invalid = run(file); expect(invalid.status).toBe(1); expect(invalid.error).toBeUndefined();
  const result = run(fifo);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("[cloud-execution] operator request failed");
});
