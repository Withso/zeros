import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fixPath } = vi.hoisted(() => ({ fixPath: vi.fn() }));
vi.mock("fix-path", () => ({ default: fixPath }));

import { hydrateShellPath } from "../shell-path";

const directories: string[] = [];
beforeEach(() => {
  fixPath.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dev-path-"));
  directories.push(directory);
  const working = path.join(directory, "working node");
  const broken = path.join(directory, "broken-node");
  for (const bin of [working, broken]) fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(working, "node"),
    "#!/bin/sh\nprintf 'working-node'\n",
    { mode: 0o700 },
  );
  fs.writeFileSync(path.join(broken, "node"), "#!/bin/sh\nexit 134\n", {
    mode: 0o700,
  });
  const env = {
    PATH: `${working}:${broken}:/usr/bin:/bin`,
    ZEROS_DEV_NODE_EXECUTABLE: path.join(working, "node"),
  };
  return {
    env,
    working,
    broken,
    loadShellPath: () => {
      env.PATH = `${broken}:/usr/bin:/bin:${working}`;
    },
  };
}

describe.skipIf(process.platform === "win32")(
  "desktop shell PATH hydration",
  () => {
    it.each([false, true])(
      "uses fix-path with the same PATH semantics (Local=%s)",
      async (local) => {
        vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", "1");
        vi.stubEnv("PATH", process.env.PATH);
        let inherited: string | undefined;
        fixPath.mockImplementation(() => {
          inherited = execFileSync(
            "/bin/sh",
            ["-c", 'printf "%s" "$ZEROS_LOCAL_DEVELOPMENT"'],
            { encoding: "utf8" },
          );
          process.env.PATH = "/fix-path-result";
        });
        await hydrateShellPath({ development: false, localDevelopment: local });
        expect(fixPath).toHaveBeenCalledOnce();
        expect(inherited).toBe(local ? "" : "1");
        expect(process.env.PATH).toBe("/fix-path-result");
        expect(process.env.ZEROS_LOCAL_DEVELOPMENT).toBe("1");
      },
    );

    it("restores Local admission when synchronous fix-path fails", async () => {
      vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", "1");
      fixPath.mockImplementation(() => {
        expect(process.env.ZEROS_LOCAL_DEVELOPMENT).toBeUndefined();
        throw new Error("synthetic shell failure");
      });
      await hydrateShellPath({ development: false, localDevelopment: true });
      expect(fixPath).toHaveBeenCalledOnce();
      expect(console.warn).toHaveBeenCalledOnce();
      expect(process.env.ZEROS_LOCAL_DEVELOPMENT).toBe("1");
    });

    it("keeps the launched Dev Node ahead of a broken Node from login-shell initialization", async () => {
      const f = fixture();
      await hydrateShellPath({ ...f, development: true });
      expect(execFileSync("node", [], { env: f.env, encoding: "utf8" })).toBe(
        "working-node",
      );
      expect(
        f.env.PATH.split(":"),
        "keep other user CLIs and avoid duplicate entries",
      ).toEqual([f.working, f.broken, "/usr/bin", "/bin"]);
    });

    it("restores the Dev Node even when shell initialization changes PATH and then fails", async () => {
      const f = fixture();
      await hydrateShellPath({
        env: f.env,
        development: true,
        loadShellPath: () => {
          f.loadShellPath();
          throw new Error("shell initialization failed");
        },
      });
      expect(execFileSync("node", [], { env: f.env, encoding: "utf8" })).toBe(
        "working-node",
      );
      expect(console.warn).toHaveBeenCalledOnce();
    });

    it("leaves packaged and ordinary GUI launches on the user's shell PATH", async () => {
      const f = fixture();
      await hydrateShellPath({ ...f, development: false });
      expect(f.env.PATH).toBe(`${f.broken}:/usr/bin:/bin:${f.working}`);
      delete (f.env as NodeJS.ProcessEnv).ZEROS_DEV_NODE_EXECUTABLE;
      await hydrateShellPath({ ...f, development: true });
      expect(f.env.PATH).toBe(`${f.broken}:/usr/bin:/bin:${f.working}`);
    });

    it.each([
      "relative/node",
      "/missing/toolchain/node",
      "/usr/bin/sh",
      "/tmp/node\u0000",
    ])("ignores an unusable runtime hint: %s", async (executable) => {
      const f = fixture();
      f.env.ZEROS_DEV_NODE_EXECUTABLE = executable;
      await hydrateShellPath({ ...f, development: true });
      expect(f.env.PATH).toBe(`${f.broken}:/usr/bin:/bin:${f.working}`);
    });
  },
);
