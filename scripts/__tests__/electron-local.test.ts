import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import {
  checkoutIdentity,
  localEnvironment,
  pickLocalPorts,
  runLocalDevelopment,
  runOwnedProcess,
} from "../electron-local.mjs";

const roots: string[] = [];
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-test-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("Local checkout identity and environment", () => {
  it("isolates ordinary clones, synced .git directories and linked worktrees without branch identity", () => {
    const parent = directory(),
      clone = path.join(parent, "clone"),
      worktree = path.join(parent, "linked"),
      sync = path.join(parent, "sync");
    for (const root of [clone, worktree, sync]) fs.mkdirSync(root);
    execFileSync("git", ["init", "--quiet", clone]);
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /unneeded/metadata");
    fs.mkdirSync(path.join(sync, ".git"));
    const before = checkoutIdentity(clone);
    execFileSync("git", [
      "-C",
      clone,
      "symbolic-ref",
      "HEAD",
      "refs/heads/renamed",
    ]);
    expect(checkoutIdentity(clone)).toEqual(before);
    const alias = path.join(parent, "alias");
    fs.symlinkSync(clone, alias);
    expect(checkoutIdentity(alias)).toEqual(before);
    expect(
      new Set(
        [clone, worktree, sync].map((root) => checkoutIdentity(root).slug),
      ).size,
    ).toBe(3);
    expect(before.name).toContain("Zeros Local");
  });

  it("drops inherited desktop/hosted authority and overrides dotenv public backend values without dropping provider login", () => {
    const identity = checkoutIdentity(directory());
    const env = localEnvironment({
      identity,
      vitePort: 6400,
      engineBase: 31000,
      environment: {
        PATH: "/test/bin",
        HOME: "/test/home",
        OPENAI_API_KEY: "synthetic-provider",
        CODEX_HOME: "/provider",
        ZEROS_INSTANCE: "parent",
        ZEROS_CHANNEL: "alpha",
        ZEROS_DATA_DIR: "/hosted",
        ZEROS_SHARED_SECRETS_DIR: "/hosted",
        ZEROS_DEV_PROFILE_B64: "synthetic-profile",
        ZEROS_JWT_ISSUER: "synthetic-issuer",
        AUTH_DESKTOP_CLIENT_ID: "synthetic-client",
        VITE_CONTROL_PLANE_URL: "https://backend.example.test",
        VITE_POSTHOG_KEY_PROD: "synthetic-key",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    expect(env.ZEROS_INSTANCE).toBe(identity.slug);
    expect(env.ZEROS_LOCAL_DEVELOPMENT).toBe("1");
    expect(env.ZEROS_CHANNEL).toBe("dev");
    expect(env.ZEROS_DATA_DIR).toBeUndefined();
    expect(env.ZEROS_SHARED_SECRETS_DIR).toBeUndefined();
    expect(env.ZEROS_DEV_PROFILE_B64).toBeUndefined();
    expect(env.ZEROS_JWT_ISSUER).toBeUndefined();
    expect(env.AUTH_DESKTOP_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CONTROL_PLANE_URL).toBe("");
    expect(env.VITE_POSTHOG_KEY_PROD).toBe("");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("synthetic-provider");
    expect(env.CODEX_HOME).toBe("/provider");
    expect(env.ELECTRON_RENDERER_URL).toBe("http://localhost:6400");
  });

  it("checks every engine/gateway port and keeps Local outside hosted Dev's port grid", async () => {
    const id = checkoutIdentity(directory());
    const first = await pickLocalPorts(id.slug);
    expect(first.engineBase).toBeGreaterThanOrEqual(31000);
    const occupied = net.createServer();
    occupied.listen(first.engineBase + 9, "127.0.0.1");
    await once(occupied, "listening");
    try {
      expect((await pickLocalPorts(id.slug)).engineBase).not.toBe(
        first.engineBase,
      );
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
    expect(await pickLocalPorts(id.slug)).toEqual(first);
  });
});

describe("Local launch ownership", () => {
  it("refuses a same-checkout Dev process before build, bundle or lock work", async () => {
    const root = directory();
    const alias = path.join(directory(), "alias");
    fs.symlinkSync(root, alias);
    let ran = false;
    for (const launchRoot of [root, alias]) {
      await expect(
        runLocalDevelopment({
          root: launchRoot,
          platform: "darwin",
          environment: {},
          listProcesses: () => `123 node ${root}/scripts/dev-instance.mjs`,
          run: async () => {
            ran = true;
            return { code: 0 };
          },
          prepareBundle: () => {
            ran = true;
            return "/unused";
          },
        }),
      ).rejects.toThrow(/Zeros Dev.*checkout/);
      expect(ran).toBe(false);
      expect(fs.existsSync(path.join(root, ".context"))).toBe(false);
    }
  });

  it("adds a separate Mac Conductor entry while preserving hosted commands and defaults", () => {
    const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts;
    expect(scripts["electron:local"]).toBe("node scripts/electron-local.mjs");
    expect(scripts["electron:dev"]).toBe(
      "node scripts/dev-environment/hosted-entry.mjs start",
    );
    expect(scripts["dev:backend"]).toBe(
      "node scripts/dev-environment/hosted-entry.mjs backend",
    );
    const settings = parse(
      fs.readFileSync(".conductor/settings.toml", "utf8"),
    ) as {
      scripts: {
        run: Record<
          string,
          { available_in: string[]; default?: boolean; command: string }
        >;
      };
    };
    expect(settings.scripts.run["Zeros Local"]).toMatchObject({
      available_in: ["local"],
      icon: "monitor",
    });
    expect(settings.scripts.run["Zeros Local"]).not.toHaveProperty("default");
    expect(settings.scripts.run["Zeros Local"].command).toContain(
      "zeros_dev_select_tools",
    );
    expect(settings.scripts.run.dev.default).toBe(true);
    expect(settings.scripts.run.backend.default).toBe(true);
  });

  it("does not let a second launcher rebuild the same checkout", async () => {
    const root = directory(),
      controller = new AbortController();
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = runLocalDevelopment({
      root,
      platform: "darwin",
      environment: {},
      signal: controller.signal,
      run: async () => {
        entered();
        await pending;
        return { code: 0, cancelled: true };
      },
    });
    await ready;
    try {
      await expect(
        runLocalDevelopment({ root, platform: "darwin" }),
      ).rejects.toThrow("already running");
    } finally {
      controller.abort();
      finish();
      await first;
    }
    expect(
      fs.existsSync(path.join(root, ".context/zeros-local/launcher.lock")),
    ).toBe(false);
  });
  it.each([
    process.execPath,
    "/opt/hostedtoolcache/node/22.18.0/x64/bin/node",
    "/opt/hosted-node/node/22.18.0/x64/bin/node",
  ])(
    "keeps Local builds, bounded retries and one profile with Node at %s",
    async (execPath) => {
      const root = directory(),
        calls: Array<{
          command: string;
          args: string[];
          env: Record<string, string>;
        }> = [];
      const originalExecPath = process.execPath;
      let code: number;
      Object.defineProperty(process, "execPath", { value: execPath });
      try {
        code = await runLocalDevelopment({
          root,
          platform: "darwin",
          environment: {},
          prepareBundle: () => "/local/Electron",
          portProber: async (port: number) => {
            for (const previous of calls.filter((call) =>
              call.args.includes("concurrently"),
            )) {
              expect(port).not.toBe(Number(previous.env.ZEROS_VITE_PORT));
              const base = Number(previous.env.ZEROS_ENGINE_BASE_PORT);
              expect(port < base || port >= base + 10).toBe(true);
            }
            return true;
          },
          run: async (
            command: string,
            args: string[],
            options: { env: Record<string, string> },
          ) => {
            calls.push({ command, args, env: options.env });
            return {
              code: args.includes("concurrently") ? 98 : 0,
              cancelled: false,
            };
          },
        });
      } finally {
        Object.defineProperty(process, "execPath", { value: originalExecPath });
      }
      expect(code).not.toBe(0);
      expect(calls[0].args).toEqual(["electron:dev:prep"]);
      const stacks = calls.filter((call) => call.args.includes("concurrently"));
      expect(stacks).toHaveLength(3);
      expect(new Set(calls.map((call) => call.env.ZEROS_INSTANCE)).size).toBe(
        1,
      );
      expect(new Set(stacks.map((call) => call.env.ZEROS_VITE_PORT)).size).toBe(
        3,
      );
      expect(stacks[0].args.join(" ")).toContain("dev-main-supervisor.mjs");
      expect(stacks[0].args.join(" ")).toContain(`'${execPath}'`);
      expect(
        calls.some((call) =>
          /scripts\/dev-environment\/|hosted-|\belectron:dev\b(?!:prep\b)|setup-zeros-dev|dev-instance\.mjs|\bdev:backend\b/.test(
            call.args.join(" ").replaceAll(`'${execPath}'`, ""),
          ),
        ),
      ).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32").each([false, true])(
    "executes a symlinked checkout path (preserve main symlink=%s)",
    (preserve) => {
      const root = directory();
      const alias = path.join(root, "linked checkout");
      const preload = path.join(root, "platform.cjs");
      fs.symlinkSync(path.resolve("."), alias, "dir");
      fs.writeFileSync(
        preload,
        "Object.defineProperty(process,'platform',{value:'linux'});",
      );
      const result = spawnSync(
        process.execPath,
        [
          ...(preserve ? ["--preserve-symlinks-main"] : []),
          "--require",
          preload,
          path.join(alias, "scripts/electron-local.mjs"),
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Zeros Local requires macOS.");
      expect(fs.existsSync(path.join(root, ".context/zeros-local"))).toBe(
        false,
      );
    },
    30_000,
  );

  it("rejects Linux before any build, profile or bundle work", async () => {
    await expect(runLocalDevelopment({ platform: "linux" })).rejects.toThrow(
      "macOS",
    );
  });

  it("cancels preparation without continuing into the app stack", async () => {
    const controller = new AbortController();
    let count = 0;
    const code = await runLocalDevelopment({
      root: directory(),
      platform: "darwin",
      environment: {},
      signal: controller.signal,
      prepareBundle: () => {
        throw new Error("must not prepare bundle");
      },
      run: async () => {
        count++;
        controller.abort();
        return { code: 0, cancelled: true };
      },
    });
    expect(code).toBe(0);
    expect(count).toBe(1);
  });

  it("forwards cancellation to the owned process group and waits for child cleanup", async () => {
    const root = directory(),
      marker = path.join(root, "stopped");
    const controller = new AbortController();
    const child = `process.on('SIGTERM',()=>{setTimeout(()=>{require('fs').writeFileSync(process.argv[1],'clean');process.exit(0)},100)});setInterval(()=>{},1000);console.log('ready')`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)},process.argv[1]],{stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>{},1);`;
    const result = await runOwnedProcess(
      process.execPath,
      ["-e", parent, marker],
      {
        cwd: root,
        env: process.env,
        signal: controller.signal,
        killGraceMs: 400,
        output: (text: string) => {
          if (text.includes("ready")) controller.abort();
        },
      },
    );
    expect(result.cancelled).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("clean");
  });
});
