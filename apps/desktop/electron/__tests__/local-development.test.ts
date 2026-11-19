import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { CHANNELS, isChannel } from "../../src/engine/runtime";
import { assertDevelopmentAdmission, assertDevelopmentOverrideIsolated, sharedSecretsDirectory } from "../storage-identity";
// @ts-expect-error The Node launcher is JavaScript; exercise its real boot environment.
import { localEnvironment } from "../../../../scripts/electron-local.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("native Local development admission", () => {
  function initializeIdentity(
    local: boolean,
    env: Record<string, string | undefined>,
    build: { packaged?: boolean; baked?: string } = {},
  ) {
    const source = fs.readFileSync("apps/desktop/electron/main.ts", "utf8");
    // Include the earlier environment authority, not only the sharing condition.
    const start = source.indexOf("const explicitDevEnv =");
    const end = source.indexOf("function relocateChromiumCache", start);
    if (start < 0 || end < 0) throw new Error("main.ts identity block markers moved");
    const development = () => env.ZEROS_CHANNEL === "dev";
    const instanceDir = (instance: string) => `/data/com.zeros.local/instances/${instance}`;
    const sharedRoot = development() ? "/data/com.zeros.local" : `/data/com.zeros.${env.ZEROS_CHANNEL}`;
    vm.runInNewContext(transformSync(source.slice(start, end), { loader: "ts" }).code, {
      IS_DEV: build.packaged === undefined ? env.ZEROS_CHANNEL === "dev" : !build.packaged,
      IS_PACKAGED: build.packaged === undefined ? env.ZEROS_CHANNEL !== "dev" : build.packaged,
      __ZEROS_CHANNEL_BAKED__: build.baked ?? "",
      IS_LOCAL_DEVELOPMENT: local,
      process: { env },
      isChannel,
      CHANNELS,
      seedCloudWorkspaceDesktopCapabilityEnvironment() {}, migrateElectronIdentity() {},
      storageFamily: () => (development() ? "development" : "installed"),
      developmentInstance: () => (development() ? env.ZEROS_INSTANCE || "default" : null),
      assertDevelopmentAdmission,
      assertDevelopmentOverrideIsolated,
      sharedSecretsDirectory,
      zerosDataDir: () => (development() ? instanceDir(env.ZEROS_INSTANCE || "default") : sharedRoot),
      zerosChannelDataDir: () => sharedRoot,
      zerosDevelopmentDataDir: instanceDir,
      app: { getPath: () => "/data", setName() {}, setPath() {} },
      realProfileRoots: () => ({ profileRoots: ["/data/com.zeros", "/data/com.zeros.alpha", "/data/com.zeros.local"], appData: "/data" }),
      path,
    });
    return env;
  }

  it.each([false, true])("shares the channel secret store across checkouts (local=%s)", (local) => {
    for (const [checkout, hosted] of [["0123456789abcdef", "design-owner-1"], ["fedcba9876543210", "feature-x"]]) {
      const env = local ? localEnvironment({
        identity: { slug: checkout, name: "Fixture" }, vitePort: 6400, engineBase: 31000, environment: {},
      }) : { ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: hosted };
      expect(initializeIdentity(local, env).ZEROS_SHARED_SECRETS_DIR).toBe(
        local ? "/data/com.zeros.local" : "/data/com.zeros.local/instances/alpha",
      );
    }
  });

  it.each([undefined, "0", "1"])("clears inherited hosted secrets and honors explicit Local isolation %s", (isolate) => {
    const env = localEnvironment({
      identity: { slug: "0123456789abcdef", name: "Fixture" }, vitePort: 6400, engineBase: 31000,
      environment: { ZEROS_ISOLATE: isolate },
    });
    // Main is also authoritative for direct launches that bypass the launcher.
    env.ZEROS_SHARED_SECRETS_DIR = "/data/com.zeros.dev";
    initializeIdentity(true, env);
    expect(env.ZEROS_ISOLATE).toBe(isolate);
    expect(env.ZEROS_SHARED_SECRETS_DIR).toBe(isolate === "1" ? undefined : "/data/com.zeros.local");
  });

  it.each([true, false])("refuses a non-empty unknown baked channel before choosing any storage (packaged=%s)", (packaged) => {
    const env: Record<string, string | undefined> = {};
    expect(() => initializeIdentity(false, env, { packaged, baked: "beta" })).toThrow(/baked channel "beta"/);
    expect(env.ZEROS_CHANNEL).toBeUndefined();
  });

  it("lets the bake, never the environment, choose a packaged build's channel", () => {
    expect(initializeIdentity(false, {}, { packaged: true, baked: "alpha" }).ZEROS_CHANNEL).toBe("alpha");
    expect(initializeIdentity(false, {}, { packaged: true }).ZEROS_CHANNEL).toBe("stable");
    const inherited = initializeIdentity(false, {
      ZEROS_CHANNEL: "dev", ZEROS_DEV: "1", ZEROS_RUNTIME_MODE: "dev", ZEROS_LOCAL_DEVELOPMENT: "1",
      ZEROS_INSTANCE: "alpha", ZEROS_SHARED_SECRETS_DIR: "/data/com.zeros.local",
    }, { packaged: true, baked: "alpha" });
    expect(inherited).toMatchObject({ ZEROS_CHANNEL: "alpha" });
    for (const key of ["ZEROS_DEV", "ZEROS_RUNTIME_MODE", "ZEROS_LOCAL_DEVELOPMENT", "ZEROS_SHARED_SECRETS_DIR"])
      expect(inherited[key], key).toBeUndefined();
    expect(initializeIdentity(false, { ZEROS_CHANNEL: "dev", ZEROS_DEV: "1" }, { packaged: true }).ZEROS_CHANNEL).toBe("stable");
    expect(() => initializeIdentity(false, {}, { packaged: true, baked: "dev" })).toThrow(/packaged/);
    // Unpackaged development keeps its explicit environment channel.
    expect(initializeIdentity(false, { ZEROS_CHANNEL: "alpha" }, { packaged: false }).ZEROS_CHANNEL).toBe("alpha");
  });

  it("refuses a development ZEROS_DATA_DIR that points into a real Zeros profile, and never shares a store under one", () => {
    const local = (extra: Record<string, string>) => ({
      ...localEnvironment({ identity: { slug: "a123456789abcdef", name: "Fixture" }, vitePort: 6400, engineBase: 31000, environment: {} }),
      ...extra,
    });
    for (const dataDir of ["/data/com.zeros.local/instances/alpha", "/data/com.zeros.local", "/data/com.zeros.alpha", "/data/com.zeros/sub"])
      expect(() => initializeIdentity(true, local({ ZEROS_DATA_DIR: dataDir })), dataDir).toThrow(/ZEROS_DATA_DIR/);
    expect(initializeIdentity(true, local({ ZEROS_DATA_DIR: "/tmp/fixture" })).ZEROS_SHARED_SECRETS_DIR).toBeUndefined();
    expect(initializeIdentity(false, { ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: "design-owner-1", ZEROS_DATA_DIR: "/tmp/fixture" }).ZEROS_SHARED_SECRETS_DIR).toBeUndefined();
  });

  it("leaves an installed build's ZEROS_DATA_DIR as it has always behaved", () => {
    for (const baked of ["stable", "alpha"])
      expect(initializeIdentity(false, { ZEROS_DATA_DIR: "/data/com.zeros/sub" }, { packaged: true, baked }).ZEROS_CHANNEL).toBe(baked);
  });

  it("refuses a retired beta channel at boot like any unknown channel", () => {
    expect(() => initializeIdentity(false, { ZEROS_CHANNEL: "beta" }, { packaged: false })).toThrow(/not a known channel/);
    expect(initializeIdentity(false, { ZEROS_CHANNEL: "beta" }, { packaged: true }).ZEROS_CHANNEL).toBe("stable");
  });

  it("keeps electron:alpha's account store private and refuses Local admission on it", () => {
    const env = initializeIdentity(false, {
      ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: "alpha", ZEROS_SHARED_SECRETS_DIR: "/data/com.zeros.local",
    });
    expect(env.ZEROS_SHARED_SECRETS_DIR).toBe("/data/com.zeros.local/instances/alpha");
    expect(() => initializeIdentity(true, {
      ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: "alpha", ZEROS_LOCAL_DEVELOPMENT: "1",
    })).toThrow(/checkout's own instance/);
    // Review A finding 5: one checkout hash used by a hosted launch.
    expect(() => initializeIdentity(false, { ZEROS_CHANNEL: "dev", ZEROS_INSTANCE: "0123456789abcdef" })).toThrow(/checkout id/);
  });

  it.each(["alpha", "stable"])("never shares a development store with %s", (channel) => {
    const env = initializeIdentity(false, {
      ZEROS_CHANNEL: channel, ZEROS_LOCAL_DEVELOPMENT: "1", ZEROS_SHARED_SECRETS_DIR: "/data/com.zeros.local",
    });
    expect(env.ZEROS_SHARED_SECRETS_DIR).toBeUndefined();
    expect(env.ZEROS_LOCAL_DEVELOPMENT).toBeUndefined();
  });

  it.each([
    [true, "1", "dev", true],
    [true, undefined, "dev", false],
    [true, "true", "dev", false],
    [false, "1", "dev", false],
    [false, "1", "alpha", false],
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
            "stable",
          ]) {
            for (const bakedChannel of ["", "dev", "alpha", "stable"]) {
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
    [false, "pnpm electron:local"],
    [true, "pnpm electron:alpha"],
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
