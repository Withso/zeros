import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The image helper is plain Node JavaScript.
import {
  cloudImageSourceIdentity,
  cloudImageBaseOrigin,
  cloudImageArtifactHashes,
  cloudImageBuildMatchesInstallation,
} from "../cloud-workspace-validation/sandbox/image-build-contract.mjs";

const directories: string[] = [];
function fixture() {
  const engine = mkdtempSync(path.join(tmpdir(), "zeros-image-provenance-"));
  directories.push(engine);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", engine, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  git("init", "--quiet");
  const files = [
    "package.json",
    "pnpm-lock.yaml",
    "scripts/zsr-qualification/pin.json",
    "scripts/cloud-workspace-validation/sandbox/cloud-worker.json",
    "scripts/cloud-workspace-validation/sandbox/runtime-layout.json",
  ];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(engine, file)), { recursive: true });
    writeFileSync(path.join(engine, file), "{}\n");
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Qualification",
    "-c",
    "user.email=qualification@example.test",
    "commit",
    "--quiet",
    "-m",
    "qualification fixture",
  );
  for (const file of [
    "dist-engine/cli.js",
    "dist-engine/design-capture-worker.js",
    "binaries/zsr-supervisor.mjs",
  ]) {
    mkdirSync(path.dirname(path.join(engine, file)), { recursive: true });
    writeFileSync(path.join(engine, file), "export {};\n");
  }
  return { engine, git };
}
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe("qualified image provenance", () => {
  it("checks source without reading or regenerating a mutable image Git index", () => {
    const { engine, git } = fixture();
    const commit = git("rev-parse", "HEAD");
    rmSync(path.join(engine, ".git/index"));
    expect(cloudImageSourceIdentity(engine).commit).toBe(commit);
    expect(existsSync(path.join(engine, ".git/index"))).toBe(false);
  });
  it.each(["--assume-unchanged", "--skip-worktree"])("does not trust cached index flags %s to hide changed source", (flag) => {
    const { engine, git } = fixture();
    git("update-index", flag, "package.json");
    writeFileSync(path.join(engine, "package.json"), '{"substituted":true}\n');
    expect(() => cloudImageSourceIdentity(engine)).toThrow(/source/);
  });
  it("binds the actual source tree and rejects modified or staged source", () => {
    const { engine, git } = fixture();
    expect(cloudImageSourceIdentity(engine)).toMatchObject({
      commit: git("rev-parse", "HEAD"),
      contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    writeFileSync(path.join(engine, "package.json"), '{"changed":true}\n');
    expect(() => cloudImageSourceIdentity(engine)).toThrow(/source/);
    git("add", "package.json");
    expect(() => cloudImageSourceIdentity(engine)).toThrow(/source/);
  });
  it("records native Linux inventory without claiming an OCI base", () => {
    const inventory = {
      osReleaseSha256: "a".repeat(64),
      packageInventorySha256: "b".repeat(64),
      nodeSha256: "c".repeat(64),
    };
    const native = cloudImageBaseOrigin("native-linux", inventory);
    expect(native).toMatchObject({
      baseImage: expect.stringMatching(/^native-linux@sha256:[a-f0-9]{64}$/),
      baseOrigin: { kind: "native-linux", ...inventory },
    });
    const oci = "node:22@sha256:" + "d".repeat(64);
    expect(cloudImageBaseOrigin(oci, inventory)).toEqual({
      baseImage: oci,
      baseOrigin: { kind: "oci", reference: oci },
    });
    expect(() => cloudImageBaseOrigin("node:latest", inventory)).toThrow(
      /base/,
    );
    expect(() =>
      cloudImageBaseOrigin("native-linux", {
        ...inventory,
        nodeSha256: "unknown",
      }),
    ).toThrow(/base/);
  });
  it("detects compiled artifact substitution independently of source identity", () => {
    const { engine } = fixture();
    const source = cloudImageSourceIdentity(engine);
    const artifacts = cloudImageArtifactHashes(engine);
    const build = { version: 2, source, artifacts };
    expect(cloudImageBuildMatchesInstallation(build, engine)).toBe(true);
    writeFileSync(path.join(engine, "dist-engine/cli.js"), "changed runtime\n");
    expect(cloudImageBuildMatchesInstallation(build, engine)).toBe(false);
    expect(
      cloudImageBuildMatchesInstallation(
        { ...build, source: { ...source, commit: "b".repeat(40) } },
        engine,
      ),
    ).toBe(false);
    expect(Object.keys(artifacts)).toContain("dist-engine/cli.js");
  });
});
