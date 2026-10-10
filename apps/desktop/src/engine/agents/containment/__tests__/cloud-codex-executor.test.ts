import { spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudNativeHome } from "../cloud-native-home";

describe("same-user Codex workspace executor", () => {
  it("keeps the original physical provider/tool HOME and XDG with only selected actor environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-executor-home-"));
    try {
      const nativeHome = await createCloudNativeHome({ dataRoot: root, provider: "codex", conversationId: "executor", executionId: "native-run" });
      const helper = path.join(root, "cloud-codex-executor.mjs"), binary = path.join(root, "native-executor.cjs");
      await copyFile(path.resolve("apps/desktop/src/engine/agents/containment/cloud-codex-executor.mjs"), helper);
      await writeFile(path.join(root, "cloud-runtime-root.mjs"),
        "export const resolveCloudRuntimeChild=()=>({workerRoot:new URL('.',import.meta.url).pathname.replace(/\\/$/,''),binRoot:" + JSON.stringify(path.dirname(process.execPath)) + ",profile:'v4'});export const assertCloudRuntimeChildPath=file=>{if(file!==new URL('./native-executor.cjs',import.meta.url).pathname)throw new Error('foreign binary');};");
      await writeFile(binary, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,codexHome:process.env.CODEX_HOME,config:process.env.XDG_CONFIG_HOME,cache:process.env.XDG_CACHE_HOME,data:process.env.XDG_DATA_HOME,state:process.env.XDG_STATE_HOME,actor:process.env.TEST_ACTOR,providerCredentialsPresent:['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','CURSOR_API_KEY'].some(key=>Boolean(process.env[key]))}));", { mode: 0o700 });
      const child = spawn(process.execPath, [helper, binary], { cwd: root,
        env: { ...nativeHome.environment(), TEST_ACTOR: "sending-member" }, stdio: ["ignore", "pipe", "pipe"] });
      const output: Buffer[] = []; child.stdout.on("data", (value) => output.push(value)); child.stderr.resume();
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      expect(code).toBe(0);
      expect(JSON.parse(Buffer.concat(output).toString())).toEqual({ args: ["exec-server", "--listen", "stdio"],
        home: nativeHome.paths.home, codexHome: nativeHome.paths.codexHome, config: nativeHome.paths.xdgConfigHome,
        cache: nativeHome.paths.xdgCacheHome, data: nativeHome.paths.xdgDataHome, state: nativeHome.paths.xdgStateHome,
        actor: "sending-member", providerCredentialsPresent: false });
      expect((await lstat(nativeHome.paths.home)).isDirectory()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
