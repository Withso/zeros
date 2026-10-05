import { afterEach, describe, expect, it, vi } from "vitest";
import { runFile } from "../../git/git-exec";
import { gitProcessOptions } from "../../git/git-execution-identity";
import { mergeSpawnEnv } from "../../settings/spawn-env";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getLoginShellPath,
  resetLoginShellPathForTests,
} from "../../agents/adapters/shared/login-shell-path";
import { hydrateShellPath } from "../../../../electron/shell-path";
import { materializeMcpServerRegistration } from "../../agents/mcp-registration";

afterEach(() => vi.unstubAllEnvs());

describe("Local admission at external process boundaries", () => {
  it.each([false, true])(
    "keeps Local admission out of login-shell initialization (main=%s)",
    async (main) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-shell-"));
      const shell = path.join(root, "shell");
      fs.writeFileSync(
        shell,
        '#!/bin/sh\nif [ -n "$ZEROS_LOCAL_DEVELOPMENT" ]; then echo /leaked-local; else echo /clean-local; fi\n',
        { mode: 0o700 },
      );
      vi.stubEnv("SHELL", shell);
      vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", "1");
      vi.stubEnv("PATH", process.env.PATH);
      resetLoginShellPathForTests();
      try {
        if (main) {
          await hydrateShellPath({ development: true });
          expect(process.env.PATH).toContain("/clean-local");
        } else expect(await getLoginShellPath()).toBe("/clean-local");
        expect(process.env.ZEROS_LOCAL_DEVELOPMENT).toBe("1");
      } finally {
        resetLoginShellPathForTests();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("strips explicit Local admission from managed MCP server overrides", () => {
    const server = materializeMcpServerRegistration(
      {
        name: "test",
        transport: "stdio",
        command: "node",
        env: { ZEROS_LOCAL_DEVELOPMENT: "1", SAFE: "kept" },
      },
      {},
    );
    expect(server).toMatchObject({ env: { SAFE: "kept" } });
    expect(
      "env" in server && server.env?.ZEROS_LOCAL_DEVELOPMENT,
    ).toBeUndefined();
  });
  it("does not give tools the ambient Local flag", async () => {
    vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", "1");
    const result = await runFile(process.execPath, [
      "-e",
      "process.stdout.write(String('ZEROS_LOCAL_DEVELOPMENT' in process.env))",
    ]);
    expect(result.stdout).toBe("false");
    expect(process.env.ZEROS_LOCAL_DEVELOPMENT).toBe("1");
  });
  it("does not give tools an explicitly layered Local flag", async () => {
    const result = await runFile(
      process.execPath,
      [
        "-e",
        "process.stdout.write(String('ZEROS_LOCAL_DEVELOPMENT' in process.env))",
      ],
      { env: { ZEROS_LOCAL_DEVELOPMENT: "1" } },
    );
    expect(result.stdout).toBe("false");
  });
  it("strips Local from local Git/hook environments without changing other fields", () => {
    const env = {
      ZEROS_LOCAL_DEVELOPMENT: "1",
      ZEROS_INSTANCE: "checkout",
      PATH: "/usr/bin:/bin",
    };
    expect(gitProcessOptions(env).env).toEqual({
      ZEROS_INSTANCE: "checkout",
      PATH: "/usr/bin:/bin",
    });
    expect(env.ZEROS_LOCAL_DEVELOPMENT).toBe("1");
  });
  it("cannot reintroduce Local through settings/caller layering", () => {
    const env = mergeSpawnEnv("", {
      ZEROS_LOCAL_DEVELOPMENT: "1",
      SAFE: "kept",
    });
    expect(env).toEqual({ SAFE: "kept" });
  });
});
