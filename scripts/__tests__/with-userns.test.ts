import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const helper = path.resolve("scripts/ci/with-userns.sh");
const profile = "/etc/apparmor.d/bwrap-userns-restrict";

describe("scoped CI user namespace prerequisites", () => {
  let root: string;
  let stateFile: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zeros-userns-test-"));
    stateFile = path.join(root, "state.json");
    const mock = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const stateFile = process.env.USERNS_TEST_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const tool = path.basename(process.argv[1]);
let args = process.argv.slice(2);
let status = 0;
state.calls.push([tool, ...args]);
if (tool === "sysctl") {
  if (state.noSysctl) status = 1;
  else process.stdout.write(state.restriction + "\\n");
} else if (tool === "workload") {
  state.observed = { restriction: state.restriction, loaded: state.loaded };
  status = state.commandStatus;
} else if (tool === "sudo") {
  const command = args.shift();
  if (command === "sysctl") {
    state.restriction = args.at(-1).split("=")[1];
  } else if (command === "test") {
    status = state.profilePresent ? 0 : 1;
  } else if (command === "cat") {
    process.stdout.write(state.loaded ? "bwrap (enforce)\\nunpriv_bwrap (enforce)\\n" : "");
  } else if (command === "apparmor_parser") {
    if (args.includes("--remove")) {
      state.loaded = false;
      if (state.failRemove) status = 13;
    } else if (args.includes("--replace")) {
      if (state.failRestore) status = 14;
      else state.loaded = true;
    } else status = 99;
  } else status = 98;
} else status = 97;
fs.writeFileSync(stateFile, JSON.stringify(state));
process.exit(status);
`;
    for (const tool of ["sysctl", "sudo", "workload"]) {
      await writeFile(path.join(root, tool), mock, { mode: 0o755 });
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function run(overrides: Record<string, unknown> = {}) {
    await writeFile(
      stateFile,
      JSON.stringify({
        restriction: "1",
        profilePresent: true,
        loaded: true,
        commandStatus: 0,
        calls: [],
        ...overrides,
      }),
    );
    const result = spawnSync("bash", [helper, path.join(root, "workload")], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        USERNS_TEST_STATE: stateFile,
      },
      encoding: "utf8",
    });
    return { ...result, state: JSON.parse(await readFile(stateFile, "utf8")) };
  }

  it.each([0, 7])(
    "restores the loaded profile and sysctl after exit %i",
    async (commandStatus) => {
      const result = await run({ commandStatus });
      expect(result.status, result.stderr).toBe(commandStatus);
      expect(result.state.observed).toEqual({
        restriction: "0",
        loaded: false,
      });
      expect(result.state.restriction).toBe("1");
      expect(result.state.loaded).toBe(true);
      const parserCalls = result.state.calls.filter(
        (call: string[]) => call[1] === "apparmor_parser",
      );
      expect(parserCalls).toEqual([
        ["sudo", "apparmor_parser", "--remove", "--skip-cache", profile],
        ["sudo", "apparmor_parser", "--replace", "--skip-cache", profile],
      ]);
    },
  );

  it("keeps an already inactive profile inactive", async () => {
    const result = await run({ loaded: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.state.loaded).toBe(false);
    expect(
      result.state.calls.some(
        (call: string[]) => call[1] === "apparmor_parser",
      ),
    ).toBe(false);
  });

  it("restores a partially failed profile removal without running the command", async () => {
    const result = await run({ failRemove: true });
    expect(result.status).not.toBe(0);
    expect(result.state.observed).toBeUndefined();
    expect(result.state.loaded).toBe(true);
    expect(result.state.restriction).toBe("1");
  });

  it("reports failed profile restoration but still restores the sysctl", async () => {
    const result = await run({ failRestore: true });
    expect(result.status).not.toBe(0);
    expect(result.state.observed).toEqual({ restriction: "0", loaded: false });
    expect(result.state.restriction).toBe("1");
  });

  it("preserves a pre-existing disabled sysctl without a bwrap profile", async () => {
    const result = await run({ restriction: "0", profilePresent: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.state.restriction).toBe("0");
    expect(
      result.state.calls.some(
        (call: string[]) => call[1] === "apparmor_parser",
      ),
    ).toBe(false);
  });

  it("passes through on kernels without the optional restriction", async () => {
    const result = await run({ noSysctl: true, commandStatus: 7 });
    expect(result.status).toBe(7);
    expect(result.state.calls.map((call: string[]) => call[0])).toEqual([
      "sysctl",
      "workload",
    ]);
  });
});
