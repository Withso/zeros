import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it.runIf(process.platform === "linux")("detects the branch with engine UID 0 and checkout UID 10001", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-native-uid-"));
  await chmod(root, 0o755);
  try {
    const probe = path.resolve("apps/desktop/src/engine/git/__tests__/fixtures/native-git-root-probe.mts");
    const result = await exec("sudo", ["-n", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", process.execPath, "--import", "tsx", probe, root], { timeout: 20000 });
    expect(JSON.parse(result.stdout)).toEqual({ engineUid: 0, branch: "topic" });
  } finally {
    await exec("sudo", ["-n", "chown", "-R", `${process.getuid?.()}:${process.getgid?.()}`, root]);
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
