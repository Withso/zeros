import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it.runIf(process.platform === "linux")("detects the branch with the actual engine identity and ordinary checkout ownership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-native-uid-"));
  try {
    const probe = path.resolve("apps/desktop/src/engine/git/__tests__/fixtures/native-git-engine-probe.mts");
    const result = await exec(process.execPath,["--import","tsx",probe,root],{timeout:20000,env:{PATH:"/usr/bin:/bin"}});
    expect(JSON.parse(result.stdout)).toEqual({ engineUid: process.geteuid?.(), branch: "topic" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
