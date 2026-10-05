import fs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { withoutLocalDevelopment } from "../local-development";

it("keeps the Local admission flag out of an external browser launcher", () => {
  const parentEnv = { ZEROS_LOCAL_DEVELOPMENT: "1", PATH: "/usr/bin:/bin" };
  const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
  const module = { exports: {} as Record<string, (url: string) => void> };
  vm.runInNewContext(
    transformSync(
      fs.readFileSync(
        "apps/desktop/src/engine/agents/gateway/open-url.ts",
        "utf8",
      ),
      { loader: "ts", format: "cjs" },
    ).code,
    {
      module,
      process: { platform: "darwin", env: parentEnv },
      console,
      require: (name: string) =>
        name === "node:child_process"
          ? { spawn }
          : name.endsWith("local-development")
            ? { withoutLocalDevelopment }
            : { normalizeExternalHttpUrl: (url: string) => url },
    },
  );
  module.exports.openExternalUrl("https://provider.example.test/oauth");
  expect(spawn).toHaveBeenCalledOnce();
  const options = (
    spawn.mock.calls as unknown as [
      string,
      string[],
      { env?: Record<string, string> },
    ][]
  )[0][2];
  expect(options.env ?? parentEnv).not.toHaveProperty(
    "ZEROS_LOCAL_DEVELOPMENT",
  );
  expect(parentEnv.ZEROS_LOCAL_DEVELOPMENT).toBe("1");
});
