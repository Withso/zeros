import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createNativeGithubBroker } from "../github-native-broker";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("does not configure gh or expose GitHub credentials in a cloud environment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-native-git-only-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const broker = await createNativeGithubBroker({
    directory, visibleDirectory: directory, cwd: directory,
    path: "/usr/bin:/bin", node: process.execPath,
    source: { kind: "agent", leaseId: "11111111-1111-4111-8111-111111111111" },
    authorized: () => true,
  });
  cleanups.push(() => broker.stopAndProve());
  expect(Object.keys(broker.env).filter(key => /^(GH_|GITHUB_)/.test(key))).toEqual([]);
  await expect(readFile(path.join(directory, "config.yml"))).rejects.toThrow();
  await expect(readFile(path.join(directory, "s"))).rejects.toThrow();
  expect(JSON.stringify(broker.env)).not.toMatch(/zgp_|zgn_|ghu_/);
});
