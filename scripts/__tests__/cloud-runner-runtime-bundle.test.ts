import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

it("loads the bundled coordinator without executing a standalone manager entrypoint", () => {
  mkdirSync(".context", { recursive: true });
  const directory = mkdtempSync(path.resolve(".context/runner-import-"));
  try {
    const filename = path.join(directory, "probe.cjs");
    const external = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies).filter(name => !name.startsWith("@zeros/"));
    buildSync({ stdin: { contents: 'import {startCloudRunnerRuntime} from "./apps/desktop/src/engine/agents/containment/cloud-runner-runtime"; process.stdout.write(typeof startCloudRunnerRuntime);',
      resolveDir: process.cwd() }, bundle: true, external, platform: "node", format: "cjs", outfile: filename, logLevel: "silent",
      define: { "import.meta.url": "__bundle_url" }, banner: { js: "const __bundle_url = require('node:url').pathToFileURL(__filename).href;" } });
    const child = spawnSync(process.execPath, [filename], { encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("function");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20_000);
