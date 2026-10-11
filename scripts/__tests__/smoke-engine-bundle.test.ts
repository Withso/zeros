import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const script = fileURLToPath(
  new URL("../smoke-engine-bundle.mjs", import.meta.url),
);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "zeros-bundle-smoke-test-"));
  temporary.push(root);
  const dist = join(root, "dist-engine");
  await mkdir(dist);
  await writeFile(join(dist, "cli.js"), source);
  return { root, dist };
}

async function runGate(dist: string, timeoutMs = 2_000, env = process.env) {
  try {
    const result = await execute(
      process.execPath,
      [script, "--dist-engine", dist, "--timeout-ms", String(timeoutMs)],
      {
        env,
        timeout: 8_000,
      },
    );
    return { ...result, code: 0 };
  } catch (error) {
    return error as Error & { code: number; stdout: string; stderr: string };
  }
}

const observation = `
const fs = require("node:fs");
const path = require("node:path");
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = Number(flag("--port"));
fs.writeFileSync(path.join(__dirname, "observed.json"), JSON.stringify({
  command: process.argv[2], port, portStart: Number(flag("--port-start")),
  portSpan: Number(flag("--port-span")), root: flag("--root"), pid: process.pid,
  home: process.env.HOME, data: process.env.ZEROS_DATA_DIR,
  settings: process.env.ZEROS_USER_SETTINGS_DIR,
  workspaces: process.env.ZEROS_WORKSPACES_DIR,
  inheritedAuthority: ["OPENAI_API_KEY", "ZEROS_CLOUD_PORT", "ZEROS_PARENT_PID"].some((key) => key in process.env),
}));
`;

async function assertCleaned(dist: string) {
  const observed = JSON.parse(
    await readFile(join(dist, "observed.json"), "utf8"),
  );
  expect(() => process.kill(observed.pid, 0)).toThrow();
  await expect(stat(dirname(observed.home))).rejects.toMatchObject({
    code: "ENOENT",
  });
  return observed;
}

describe("bundled engine startup gate", () => {
  it("runs serve on one free port with disposable state and cleans up after readiness", async () => {
    const { dist } = await fixture(`${observation}
process.stdout.write("[Zeros] Engine rea");
setTimeout(() => process.stdout.write("dy on port " + port + " (1ms)\\n"), 10);
setInterval(() => {}, 1000);
`);
    const result = await runGate(dist, 2_000, {
      ...process.env,
      OPENAI_API_KEY: "synthetic-fixture",
      ZEROS_CLOUD_PORT: "9999",
      ZEROS_PARENT_PID: "1",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Engine ready");
    const observed = await assertCleaned(dist);
    expect(observed).toMatchObject({
      command: "serve",
      portSpan: 1,
      inheritedAuthority: false,
    });
    expect(observed.port).toBeGreaterThan(0);
    expect(observed.portStart).toBe(observed.port);
    for (const name of ["root", "data", "settings", "workspaces"])
      expect(dirname(observed[name])).toBe(dirname(observed.home));
  });

  it("rejects a successfully built CommonJS graph that fails during dynamic import", async () => {
    const { root, dist } = await fixture("");
    await writeFile(
      join(root, "cloud-ssh-session.mjs"),
      `
import { createRequire } from "node:module";
createRequire(import.meta.url);
`,
    );
    await writeFile(
      join(root, "entry.mjs"),
      `
process.on("unhandledRejection", () => console.error("[Zeros] unhandledRejection: import failed"));
void import("./cloud-ssh-session.mjs");
setInterval(() => {}, 1000);
`,
    );
    // Syntax checking and a successful CJS build both accept this regression.
    await build({
      entryPoints: [join(root, "entry.mjs")],
      outfile: join(dist, "cli.js"),
      bundle: true,
      format: "cjs",
      platform: "node",
      logLevel: "silent",
    });
    await execute(process.execPath, ["--check", join(dist, "cli.js")]);
    const result = await runGate(dist);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unhandledRejection");
  });

  it.each([0, 19])(
    "rejects early exit with code %i, even when Node reports success",
    async (code) => {
      const { dist } = await fixture(`${observation}\nprocess.exit(${code});`);
      const result = await runGate(dist);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exited before readiness");
      await assertCleaned(dist);
    },
  );

  it("does not accept a ready line followed by an immediate exit", async () => {
    const { dist } = await fixture(
      `${observation}\nconsole.log("[Zeros] Engine ready on port " + port);`,
    );
    const result = await runGate(dist);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("exited before readiness");
    await assertCleaned(dist);
  });

  it.each(["unhandledRejection", "uncaughtException"])(
    "rejects %s even if the CLI catches it and prints ready",
    async (marker) => {
      const { dist } = await fixture(`${observation}
console.log("[Zeros] Engine ready on port " + port);
setTimeout(() => console.error("[Zeros] ${marker}: synthetic failure"), 10);
setInterval(() => {}, 1000);
`);
      const result = await runGate(dist);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(marker);
      await assertCleaned(dist);
    },
  );

  it.each([false, true])(
    "times out and reaps a child without exact-port readiness (wrong port: %s)",
    async (wrongPort) => {
      const { dist } = await fixture(`${observation}
${wrongPort ? 'console.log("[Zeros] Engine ready on port " + (port + 1));' : ""}
setInterval(() => {}, 1000);
`);
      const result = await runGate(dist, 500);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("timed out");
      await assertCleaned(dist);
    },
  );
});
