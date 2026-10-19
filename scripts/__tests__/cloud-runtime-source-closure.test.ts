import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLOUD_COMMAND_ROOTS, planCloudSourceClosure, type CloudSourceClosure } from "../cloud-workspace-validation/runtime-bundle/source-closure";

describe("cloud runtime source closure", () => {
  let closure: CloudSourceClosure;
  beforeAll(async () => { closure = await planCloudSourceClosure(process.cwd()); }, 30_000);

  it("keeps the complete source qualification graph and standalone child entries", () => {
    for (const file of [
      "apps/desktop/src/cli.ts",
      "apps/desktop/src/engine/zeros-engine.ts",
      "apps/desktop/src/engine/pty/pty-host.cjs",
      "apps/desktop/src/engine/pty/resident-main.ts",
      "apps/desktop/src/engine/git/watch-host.cjs",
      "apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
      "apps/desktop/src/engine/agents/containment/cloud-checkpoint-artifacts.mjs",
      "apps/desktop/src/engine/agents/containment/cloud-engine-startup-failure.mjs",
      "apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs",
      "apps/desktop/src/engine/design/design-capture-worker.ts",
    ]) {
      expect(closure.sourceFiles).toContain(file);
      expect(closure.entryPoints).toContain(file);
    }
    for (const name of ["cloud-qualification-runtime.ts", "qualify-cloud-actor-tools.ts", "qualify-cloud-capture.ts", "qualify-cloud-human-services.ts"])
      expect(closure.entryPoints).toContain(`scripts/cloud-workspace-validation/sandbox/${name}`);
    expect(closure.sourceFiles).toContain("apps/control-plane/src/cloud-workspaces/capability-verifier.ts");
    expect(closure.sourceFiles.some(file => file.includes("/renderer/") || file.includes("/__tests__/") || /\.test\./.test(file))).toBe(false);
  });

  it("keeps native, data and language-server roots without unrelated desktop packages", () => {
    for (const name of [...CLOUD_COMMAND_ROOTS, "playwright-core", "@zeros/protocol", "@zeros/design-core", "@zeros/design-web", "sass", "tailwindcss"])
      expect(closure.dependencyRoots).toContain(name);
    for (const name of ["react", "react-dom", "lucide-react", "@codemirror/view", "@tiptap/react", "electron-updater", "posthog-js", "@zeros/cloud-client"])
      expect(closure.dependencyRoots).not.toContain(name);
  });

  it("records relative source provenance and transitive imports without host paths", () => {
    expect(Object.keys(closure.inputs).length).toBeGreaterThan(500);
    expect(closure.inputs["apps/desktop/src/engine/zeros-engine.ts"].imports.length).toBeGreaterThan(0);
    expect(JSON.stringify(closure)).not.toContain(process.cwd());
    expect(Object.keys(closure.inputs).every(file => !file.startsWith("/") && !file.split("/").includes(".."))).toBe(true);
  });

  it("discovers a standalone JavaScript child while retaining declarations as data", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-source-"));
    try {
      for (const directory of ["apps/desktop/src/engine", "scripts/cloud-workspace-validation/sandbox", "scripts/cloud-workspace-validation/lib"])
        await mkdir(path.join(source, directory), { recursive: true });
      await writeFile(path.join(source, "package.json"), JSON.stringify({
        dependencies: Object.fromEntries([...CLOUD_COMMAND_ROOTS, "late-child"].map(name => [name, "1"])),
      }));
      await writeFile(path.join(source, "apps/desktop/src/cli.ts"), "export const cli = true;\n");
      const child = "apps/desktop/src/engine/child.js", declaration = "apps/desktop/src/engine/child.d.mts";
      await writeFile(path.join(source, child), 'import "late-child";\n');
      await writeFile(path.join(source, declaration), 'export type Shape = import("types-only").Shape;\n');
      const planned = await planCloudSourceClosure(source);
      expect(planned.entryPoints).toContain(child);
      expect(planned.dependencyRoots).toContain("late-child");
      expect(planned.sourceFiles).toContain(declaration);
      expect(planned.entryPoints).not.toContain(declaration);
      expect(planned.dependencyRoots).not.toContain("types-only");
    } finally { await rm(source, { recursive: true, force: true }); }
  });
});
