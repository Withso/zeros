import { describe, expect, it } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import {
  cloudEngineViewArguments,
  cloudEngineViewEnvironment,
  cloudEngineWorkspacePaths,
} from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";

describe("fixed cloud engine mount and environment contract", () => {
  it("binds the admitted primary only inside the v4 engine namespace and retains all repos read-write", () => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const view = "/run/zeros/view/runtime-11111111-1111-4111-8111-111111111111";
      const primary = "/srv/zeros/files/repos/fixture/primary";
      const args = cloudEngineViewArguments("serve", 4, runtime, view, primary);
      const binds = args.flatMap((arg, index) => arg === "--bind" ? [[args[index + 1], args[index + 2]]] : []);
      expect(binds).toContainEqual([primary, "/srv/zeros/workspace"]);
      expect(binds).toContainEqual(["/srv/zeros/files", "/srv/zeros"]);
      expect(args.join("\n")).toContain(
        "--tmpfs\n/srv/zeros/.zeros-setup\n--chmod\n0000\n/srv/zeros/.zeros-setup\n--remount-ro\n/srv/zeros/.zeros-setup",
      );
      expect(cloudEngineWorkspacePaths(primary)).toEqual({ schema: "zeros.cloud-workspace-paths/v1",
        workspaceRoot: "/srv/zeros/workspace", repositoryAlias: "/srv/zeros/repos/fixture/primary" });
      expect(binds.some(([, target]) => target === "/srv/zeros/files/workspace")).toBe(false);
      for (const invalid of ["/srv/zeros/setup", "/srv/zeros/files/repos/../setup", "/home/user/repo", "/srv/zeros/files/repos/x/.."]) {
        expect(() => cloudEngineViewArguments("serve", 4, runtime, view, invalid)).toThrow();
        expect(() => cloudEngineWorkspacePaths(invalid)).toThrow();
      }
      expect(() => cloudEngineViewArguments("serve", 3, undefined, undefined, primary)).toThrow();
      expect(binds.some(([source]) => source === "/home/user" || source === "/srv/zeros/setup" || source === "/run/zeros")).toBe(false);
    } finally { tree.dispose(); }
  });
  it("admits only the fixed native qualification entry in the v3 engine view", () => {
    expect(cloudEngineViewArguments("qualify-agent", 3).slice(-2)).toEqual(["--v3", "--qualify-agent"]);
    expect(cloudEngineViewArguments("qualify-agent", 3)).toContain("/opt/zeros");
    expect(() => cloudEngineViewArguments("qualify-agent", 2)).toThrow();
    expect(cloudEngineViewEnvironment({ ZEROS_CLOUD_TOKEN: "private" }, "qualify-agent")).not.toHaveProperty("ZEROS_CLOUD_TOKEN");
  });
  it("keeps private attachment staging on the repository mount without exposing host authority", () => {
    const args = cloudEngineViewArguments("serve", 3);
    const binds = args.flatMap((arg, index) => arg === "--bind" ? [[args[index + 1], args[index + 2]]] : []);
    expect(binds).toContainEqual(["/srv/zeros/files", "/srv/zeros"]);
    expect(binds.some(([, target]) => target === "/srv/zeros/workspace" || target === "/srv/zeros/attachment-staging")).toBe(false);
    expect(binds.some(([source]) => source === "/srv/zeros")).toBe(false);
    expect(cloudEngineViewEnvironment({ ZEROS_ATTACHMENT_TEMP_DIR: "/untrusted" })).toHaveProperty(
      "ZEROS_ATTACHMENT_TEMP_DIR", "/srv/zeros/attachment-staging",
    );
  });
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
