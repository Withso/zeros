import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { captureDevelopmentSource, deployableSourcePath } from "../dev-environment/source.mjs";
import { cleanCheckoutCommit } from "../cloud-workspace-validation/boat-image/boat-image";
import { cloudImageSourceIdentity } from "../cloud-workspace-validation/sandbox/image-build-contract.mjs";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dev-source-")); roots.push(parent);
  const root = path.join(parent, "checkout"), state = path.join(parent, "state");
  fs.mkdirSync(root); fs.mkdirSync(state);
  const write = (file: string, text = "{}") => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
  for (const file of ["package.json", "apps/control-plane/Dockerfile", "apps/control-plane/package.json", "apps/control-plane/pnpm-lock.yaml",
    "apps/control-plane/pnpm-workspace.yaml", "apps/control-plane/tsconfig.json", "apps/control-plane/src/main.ts", "apps/control-plane/migrations/001.sql"]) write(file);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return { root, state, write };
}

describe("immutable development candidates", () => {
  it("captures uncommitted source, excludes private files and preserves the user's index", () => {
    const f = fixture(); f.write("apps/control-plane/src/main.ts", "export const value = 2;"); f.write("apps/control-plane/src/new.ts", "export const added = true;");
    f.write(".env.agent", "credential-sentinel"); f.write("apps/web/.dev.vars", "credential-sentinel");
    f.write("apps/control-plane/zeros-dev-env.json", "credential-sentinel");
    const index = fs.readFileSync(path.join(f.root, ".git/index"));
    const snapshot = captureDevelopmentSource(f.root, f.state);
    expect(fs.readFileSync(path.join(snapshot.directory, "apps/control-plane/src/main.ts"), "utf8")).toContain("2");
    expect(fs.existsSync(path.join(snapshot.directory, "apps/control-plane/src/new.ts"))).toBe(true);
    expect(fs.existsSync(path.join(snapshot.directory, ".env.agent"))).toBe(false);
    expect(fs.existsSync(path.join(snapshot.directory, "apps/web/.dev.vars"))).toBe(false);
    expect(fs.existsSync(path.join(snapshot.directory, "apps/control-plane/zeros-dev-env.json"))).toBe(false);
    expect(fs.readFileSync(path.join(f.root, ".git/index"))).toEqual(index);
    const again = captureDevelopmentSource(f.root, f.state);
    expect(again.commit).toBe(snapshot.commit); expect(again.sourceSha256).toBe(snapshot.sourceSha256);
    f.write("apps/control-plane/src/main.ts", "export const value = 3;");
    expect(captureDevelopmentSource(f.root, f.state).sourceSha256).not.toBe(snapshot.sourceSha256);
  });

  it("rejects linked source files instead of uploading unrelated local data", () => {
    const f = fixture(); fs.symlinkSync("/etc/passwd", path.join(f.root, "apps/control-plane/src/linked.ts"));
    expect(() => captureDevelopmentSource(f.root, f.state)).toThrow(/filesystem links/);
  });

  it("keeps dependency links out of the worker kit's clean-source attestation", () => {
    const f = fixture(); f.write(".gitignore", "node_modules/\n");
    f.write("node_modules/tsx/package.json");
    const snapshot = captureDevelopmentSource(f.root, f.state);
    for (const directory of [snapshot.directory, snapshot.worker.directory]) {
      fs.symlinkSync(path.join(f.root, "node_modules"), path.join(directory, "node_modules"), "dir");
      expect(cleanCheckoutCommit(directory)).toBe(directory === snapshot.directory ? snapshot.commit : snapshot.worker.commit);
      expect(execFileSync("git", ["ls-files", "node_modules"], { cwd: directory, encoding: "utf8" })).toBe("");
    }
  });

  it("includes the runtime qualification pin and runner in the attested worker source", () => {
    const f = fixture();
    f.write("pnpm-lock.yaml");
    f.write("scripts/zsr-qualification/pin.json", '{"version":"first"}');
    f.write("scripts/zsr-qualification/run.mjs", "// qualification entrypoint");
    f.write("scripts/cloud-workspace-validation/sandbox/cloud-worker.json");
    f.write("scripts/cloud-workspace-validation/sandbox/runtime-layout.json");
    const first = captureDevelopmentSource(f.root, f.state);
    expect(cloudImageSourceIdentity(first.worker.directory).commit).toBe(first.worker.commit);
    expect(fs.existsSync(path.join(first.worker.directory, "scripts/zsr-qualification/run.mjs"))).toBe(true);
    f.write("scripts/zsr-qualification/pin.json", '{"version":"second"}');
    expect(captureDevelopmentSource(f.root, f.state).workerInputsSha256).not.toBe(first.workerInputsSha256);
  });

  it("reuses worker inputs across UI-only edits but includes engine and lockfile changes", () => {
    const f = fixture(); f.write("apps/desktop/src/engine/main.ts", "export const engine = 1");
    f.write("apps/desktop/src/renderer/view.tsx", "export const view = 1");
    const first = captureDevelopmentSource(f.root, f.state);
    f.write("apps/desktop/src/renderer/view.tsx", "export const view = 2");
    const ui = captureDevelopmentSource(f.root, f.state);
    expect(ui.sourceSha256).not.toBe(first.sourceSha256);
    expect(ui.workerInputsSha256).toBe(first.workerInputsSha256);
    expect(ui.deploymentInputsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ui.deploymentInputsSha256).toBe(first.deploymentInputsSha256);
    f.write("apps/desktop/src/engine/main.ts", "export const engine = 2");
    const engine = captureDevelopmentSource(f.root, f.state);
    expect(engine.workerInputsSha256).not.toBe(ui.workerInputsSha256);
    expect(engine.deploymentInputsSha256).not.toBe(ui.deploymentInputsSha256);
    f.write("pnpm-lock.yaml", "updated lockfile");
    expect(captureDevelopmentSource(f.root, f.state).workerInputsSha256).not.toBe(engine.workerInputsSha256);
  });

  it("reuses hosted inputs for desktop-only edits but redeploys backend, web and migration changes", () => {
    const f = fixture();
    f.write("apps/desktop/electron/main.ts", "// desktop one");
    const first = captureDevelopmentSource(f.root, f.state);
    f.write("apps/desktop/electron/main.ts", "// desktop two");
    const desktop = captureDevelopmentSource(f.root, f.state);
    expect(desktop.deploymentInputsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(desktop.deploymentInputsSha256).toBe(first.deploymentInputsSha256);
    for (const file of ["apps/control-plane/src/main.ts", "apps/control-plane/migrations/002.sql", "apps/web/src/page.ts", "scripts/dev-environment/hosted-profile.mjs", "packages/protocol/src/types.ts", "pnpm-lock.yaml"]) {
      const before = captureDevelopmentSource(f.root, f.state);
      f.write(file, "changed hosted input");
      expect(captureDevelopmentSource(f.root, f.state).deploymentInputsSha256).not.toBe(before.deploymentInputsSha256);
    }
  });

  it.each(["../secret.ts", ".npmrc", "apps/control-plane/.npmrc", "apps/.env", "apps/control-plane/node_modules/private.js", "scripts/private.pem", ".context/file.ts", "apps/web/.dev.vars.production", "zeros-dev-env.json", "apps/control-plane/zeros-dev-env.json", "scripts/zeros-dev-env.json"])("excludes private deploy input %s", file => {
    expect(deployableSourcePath(file)).toBe(false);
  });
});
