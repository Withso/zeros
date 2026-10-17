import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
// @ts-expect-error The Node launcher is JavaScript; exercise its real boot environment.
import { localEnvironment } from "../../../../scripts/electron-local.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("native Local development admission", () => {
  function initializeIdentity(local: boolean, env: Record<string, string | undefined>) {
    const source = fs.readFileSync("apps/desktop/electron/main.ts", "utf8");
    // Include the earlier environment authority, not only the sharing condition.
    const start = source.indexOf("const explicitDevEnv =");
    const end = source.indexOf('// Chromium cache', start);
    const sharedRoot = local ? "/data/com.zeros.local" : `/data/com.zeros.${env.ZEROS_CHANNEL}`;
    vm.runInNewContext(transformSync(source.slice(start, end), { loader: "ts" }).code, {
      IS_DEV: env.ZEROS_CHANNEL === "dev", IS_LOCAL_DEVELOPMENT: local,
      INSTANCE_NAME: "Fixture", INSTANCE_LABEL: "Fixture",
      process: { env },
      isChannel: (value: string) => ["dev", "alpha", "beta", "stable"].includes(value),
      CHANNELS: ["dev", "alpha", "beta", "stable"],
      seedCloudWorkspaceDesktopCapabilityEnvironment() {}, migrateElectronIdentity() {},
      zerosDataDir: () => `${sharedRoot}.${env.ZEROS_INSTANCE ?? "fixture"}`,
      zerosChannelDataDir: () => sharedRoot,
      app: { getPath: () => "/data", setName() {}, setPath() {} },
    });
    return env;
  }

  it.each([false, true])("shares the channel secret store across checkouts (local=%s)", (local) => {
    for (const slug of ["checkout-a", "checkout-b"]) {
      const env = local ? localEnvironment({
        identity: { slug, name: "Fixture" }, vitePort: 6400, engineBase: 31000, environment: {},
      }) : { ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: slug };
      expect(initializeIdentity(local, env).ZEROS_SHARED_SECRETS_DIR).toBe(
        local ? "/data/com.zeros.local" : "/data/com.zeros.dev",
      );
    }
  });

  it.each([undefined, "0", "1"])("clears inherited hosted secrets and honors explicit Local isolation %s", (isolate) => {
    const env = localEnvironment({
      identity: { slug: "checkout", name: "Fixture" }, vitePort: 6400, engineBase: 31000,
      environment: { ZEROS_ISOLATE: isolate },
    });
    // Main is also authoritative for direct launches that bypass the launcher.
    env.ZEROS_SHARED_SECRETS_DIR = "/data/com.zeros.dev";
    initializeIdentity(true, env);
    expect(env.ZEROS_ISOLATE).toBe(isolate);
    expect(env.ZEROS_SHARED_SECRETS_DIR).toBe(isolate === "1" ? undefined : "/data/com.zeros.local");
  });

  it.each(["alpha", "beta", "stable"])("never shares a development store with %s", (channel) => {
    const env = initializeIdentity(false, { ZEROS_CHANNEL: channel, ZEROS_LOCAL_DEVELOPMENT: "1" });
    expect(env.ZEROS_SHARED_SECRETS_DIR).toBeUndefined();
    expect(env.ZEROS_LOCAL_DEVELOPMENT).toBeUndefined();
  });

  it.each([
    [true, "1", "dev", true],
    [true, undefined, "dev", false],
    [true, "true", "dev", false],
    [false, "1", "dev", false],
    [false, "1", "alpha", false],
    [false, "1", "beta", false],
    [false, "1", "stable", false],
    [true, "1", "alpha", false],
  ])(
    "defaultApp=%s request=%s channel=%s admits=%s",
    async (defaultApp, request, channel, expected) => {
      vi.stubGlobal("process", { ...process, defaultApp });
      vi.stubGlobal("__ZEROS_LOCAL_DEVELOPMENT_BUILD__", true);
      vi.stubGlobal("__ZEROS_CHANNEL_BAKED__", "dev");
      vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", request);
      vi.stubEnv("ZEROS_CHANNEL", channel);
      const mode = await import("../runtime-mode");
      expect(mode.IS_LOCAL_DEVELOPMENT).toBe(expected);
    },
  );

  it.each([true, false])(
    "checks request/build agreement (packaged=%s) before data initialization",
    async (packaged) => {
      for (const bakedLocal of [true, false]) {
        for (const request of ["1", undefined]) {
          for (const channel of [
            undefined,
            "",
            "dev",
            "alpha",
            "beta",
            "stable",
          ]) {
            for (const bakedChannel of ["", "dev", "alpha", "beta", "stable"]) {
              vi.resetModules();
              vi.stubGlobal("process", { ...process, defaultApp: !packaged });
              vi.stubGlobal("__ZEROS_LOCAL_DEVELOPMENT_BUILD__", bakedLocal);
              vi.stubGlobal("__ZEROS_CHANNEL_BAKED__", bakedChannel);
              vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", request);
              vi.stubEnv("ZEROS_CHANNEL", channel);
              const requested =
                !packaged &&
                request === "1" &&
                channel === "dev" &&
                ["", "dev"].includes(bakedChannel);
              const mode = await import("../runtime-mode");
              expect(mode.IS_LOCAL_DEVELOPMENT).toBe(requested && bakedLocal);
              expect(Boolean(mode.LOCAL_DEVELOPMENT_BUILD_ERROR)).toBe(
                !packaged && requested !== bakedLocal,
              );
              if (mode.IS_LOCAL_DEVELOPMENT) {
                vi.stubEnv("ZEROS_DEV", "1");
                const engine = await import("../../src/engine/runtime");
                expect(engine.isLocalDevelopmentRuntime()).toBe(true);
              }
            }
          }
        }
      }
    },
  );

  it("bakes an explicit Local marker independently from the release channel", async () => {
    for (const local of ["1", undefined]) {
      vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", local);
      vi.resetModules();
      const config = (await import("../tsup.config")).default as {
        define?: Record<string, string>;
      };
      expect(config.define?.__ZEROS_LOCAL_DEVELOPMENT_BUILD__).toBe(
        JSON.stringify(local === "1"),
      );
    }
  });

  it.each([
    [false, "Zeros Local"],
    [true, "Zeros Dev"],
  ])(
    "exits main on a rebuilt %s mode before any data work",
    async (requested, buildName) => {
      vi.stubGlobal("process", { ...process, defaultApp: true });
      vi.stubGlobal("__ZEROS_LOCAL_DEVELOPMENT_BUILD__", !requested);
      vi.stubGlobal("__ZEROS_CHANNEL_BAKED__", "dev");
      vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", requested ? "1" : undefined);
      vi.stubEnv("ZEROS_CHANNEL", "dev");
      const mode = await import("../runtime-mode");
      const source = fs.readFileSync("apps/desktop/electron/main.ts", "utf8");
      const prefix = source.slice(
        0,
        source.indexOf("import { hydrateShellPath }"),
      );
      const exit = vi.fn(() => {
        throw new Error("exit");
      });
      const data = vi.fn();
      expect(mode.LOCAL_DEVELOPMENT_BUILD_ERROR).toContain(buildName);
      expect(mode.LOCAL_DEVELOPMENT_BUILD_ERROR).toContain(
        "stop the other launcher and relaunch",
      );
      expect(() =>
        vm.runInNewContext(
          transformSync(prefix, { loader: "ts", format: "cjs" }).code +
            "\ndata();",
          {
            require: () => mode,
            process: { exit },
            console: { error: vi.fn() },
            data,
          },
        ),
      ).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(data).not.toHaveBeenCalled();
      expect(prefix).toContain("LOCAL_DEVELOPMENT_BUILD_ERROR");
    },
  );
});
