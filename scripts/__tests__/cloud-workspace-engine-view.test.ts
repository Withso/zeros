import { describe, expect, it } from "vitest";
import {
  cloudEngineViewArguments,
  cloudEngineViewEnvironment,
} from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";

describe("fixed cloud engine mount and environment contract", () => {
  it("projects only engine runtime authority and readonly control mounts", () => {
    const args = cloudEngineViewArguments();
    const mounts: Array<[string, string, string]> = [];
    for (let index = 0; index < args.length; index++) {
      if (["--bind", "--ro-bind"].includes(args[index]))
        mounts.push([args[index], args[index + 1], args[index + 2]]);
    }
    expect(mounts).toContainEqual([
      "--bind",
      "/run/zeros/engine",
      "/run/zeros",
    ]);
    expect(mounts).toContainEqual([
      "--ro-bind",
      "/sys/fs/cgroup",
      "/sys/fs/cgroup",
    ]);
    expect(mounts).toContainEqual(["--ro-bind", "/opt/zeros", "/opt/zeros"]);
    expect(mounts).toContainEqual([
      "--ro-bind",
      "/etc/containers/policy.json",
      "/etc/containers/policy.json",
    ]);
    expect(mounts).toContainEqual(["--bind", "/proc", "/proc"]);
    expect(args.join("\n")).toContain(
      "--size\n536870912\n--tmpfs\n/dev/shm\n--chmod\n1777\n/dev/shm",
    );
    expect(
      mounts.some(([, source]) =>
        ["/", "/root", "/home", "/run/zeros", "/etc", "/srv/zeros"].includes(
          source,
        ),
      ),
    ).toBe(false);
    // The native entry blocks before bwrap forks; bwrap's own late barrier
    // cannot guarantee cgroup inheritance for descendants already created.
    expect(args).not.toContain("--block-fd");
    expect(args.slice(-2)).toEqual([
      "--",
      "/opt/zeros-runtime/cloud-engine-namespace",
    ]);
    expect(cloudEngineViewArguments("qualify").at(-1)).toBe("--qualify");
    expect(cloudEngineViewArguments("qualify",3).slice(-2)).toEqual(["--v3","--qualify"]);
    expect(cloudEngineViewArguments("serve",3).at(-1)).toBe("--v3");
    expect(()=>cloudEngineViewArguments("serve",4)).toThrow(/version/);
    expect(() => cloudEngineViewArguments("shell")).toThrow(/operation/);
  });
  it("does not mask procfs entries needed for private container PID namespaces", () => {
    const args = cloudEngineViewArguments();
    for (let index = 0; index < args.length; index++) {
      if (["--bind", "--ro-bind"].includes(args[index]))
        expect(args[index + 2].startsWith("/proc/")).toBe(false);
    }
  });
  it("keeps connection authority out of argv and excludes inherited loader/provider credentials", () => {
    const source = {
      ZEROS_CLOUD_TOKEN: "test-bridge-token",
      ZEROS_CLOUD_RUNTIME_B64: "test-runtime",
      ZEROS_REQUIRE_EXACT_MODEL: "1",
      ZEROS_DATA_DIR: "/tmp/untrusted",
      NODE_OPTIONS: "--require=/tmp/untrusted",
      LD_PRELOAD: "/tmp/loader",
      BOAT_API_KEY: "test-provider",
      DAYTONA_API_KEY: "test-provider",
      OPENAI_API_KEY: "test-unrelated-model-key",
      HOME: "/root",
    };
    const environment = cloudEngineViewEnvironment(source);
    expect(environment).toMatchObject({
      ZEROS_CLOUD_TOKEN: source.ZEROS_CLOUD_TOKEN,
      ZEROS_REQUIRE_EXACT_MODEL: "1",
      ZEROS_DATA_DIR: "/srv/zeros/state",
      HOME: "/srv/zeros/home/agent",
    });
    for (const name of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "BOAT_API_KEY",
      "DAYTONA_API_KEY",
      "OPENAI_API_KEY",
    ])
      expect(environment).not.toHaveProperty(name);
    expect(cloudEngineViewArguments().join("\n")).not.toContain(
      source.ZEROS_CLOUD_TOKEN,
    );
    const qualification = cloudEngineViewEnvironment(source, "qualify");
    expect(qualification).not.toHaveProperty("ZEROS_CLOUD_TOKEN");
    expect(qualification).not.toHaveProperty("ZEROS_CLOUD_RUNTIME_B64");
  });
});
