import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { buildNativeProduction, nativeDesignModules, productionProbeSource, serveNativeProductionAssets } from "../design-native-production.mjs";
import { nativeProductionViteConfiguration } from "../design-native-vite.mjs";

it("refuses an isolated build with insufficient disk space before creating outputs or starting a compiler", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "design-production-disk-"));
  const disk = await fs.statfs(root), run = vi.fn();
  const fault = vi.spyOn(fs, "statfs").mockResolvedValue({ ...disk, bavail: 128, bsize: 4096 });
  try {
    await expect(buildNativeProduction({ repo: root, root, env: {}, run })).rejects.toThrow(/at least 4 GiB free/);
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  } finally { fault.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});

it("resolves the real native driver's module imports in the production probe", async () => {
  const repo = path.resolve(import.meta.dirname, "../..");
  for (const script of ["design-native-acceptance.mjs", "design-native-workbench.mjs", "design-native-view.mjs", "design-native-owner-access.mjs"]) {
    const source = await fs.readFile(path.join(repo, "scripts", script), "utf8");
    for (const match of source.matchAll(/import\("(\/apps\/[^\"]+)"\)/g))
      expect(nativeDesignModules, `${script} imports ${match[1]}`).toContain(match[1]);
  }
  for (const module of nativeDesignModules)
    expect((await fs.stat(path.join(repo, module.slice(1)))).isFile(), module).toBe(true);
});

it("keeps the app's singleton and deferred circular bindings in an actual optimized build", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "design-production-build-"));
  let server: Awaited<ReturnType<typeof serveNativeProductionAssets>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    vi.stubEnv("NODE_ENV", "production");
    await fs.writeFile(path.join(root, "index.html"), '<main></main><script type="module" src="/main.js"></script>');
    await fs.mkdir(path.join(root, "apps"));
    await fs.writeFile(path.join(root, "main.js"), 'import {copy} from "./apps/derived.js"; import {state} from "./apps/store.ts"; state.ready=true; document.querySelector("main").textContent=copy;');
    await fs.writeFile(path.join(root, "apps/derived.js"), 'import {state} from "./store.ts"; export const copy="ready"; export function current(){return state;}');
    await fs.writeFile(path.join(root, "apps/store.ts"), 'export {copy} from "./derived.js"; export const state={ready:false};');
    await fs.writeFile(path.join(root, "qualification.js"), productionProbeSource(root, { "/apps/store.ts": ["state", "copy"] }));
    await fs.writeFile(path.join(root, "vite.config.ts"), `export default {base:"./",build:{rollupOptions:{input:{main:${JSON.stringify(path.join(root, "index.html"))}}}}};`);
    const configFile = path.join(root, "native.config.mjs");
    await fs.writeFile(configFile, nativeProductionViteConfiguration(root, path.join(root, "cache"), path.join(root, "dist"), path.join(root, "qualification.js")));
    await build({ root, configFile, mode: "production", logLevel: "silent" });
    const manifest = JSON.parse(await fs.readFile(path.join(root, "dist/.vite/manifest.json"), "utf8"));
    const probe = Object.values(manifest).find((entry: unknown) => (entry as { name?: string }).name === "qualification") as { file: string };
    server = await serveNativeProductionAssets(path.join(root, "dist"));
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(2_000);
    await page.goto(server.url); expect(errors).toEqual([]);
    await page.locator("main").filter({ hasText: "ready" }).waitFor();
    const inspectBundle = new Function('return url => import(url).then(bundle => ({mode:bundle.build.mode,ready:bundle.modules["/apps/store.ts"].state.ready,copy:bundle.modules["/apps/store.ts"].copy}));')();
    expect(await page.evaluate(inspectBundle, `${server.url}/${probe.file}`))
      .toEqual({ mode: "production", ready: true, copy: "ready" });
  } finally { vi.unstubAllEnvs(); await browser?.close(); await server?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("serves the built renderer on loopback without source traversal, symlinks or mutation endpoints", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "design-production-assets-"));
  let server: Awaited<ReturnType<typeof serveNativeProductionAssets>> | undefined;
  try {
    const build = path.join(root, "dist"); await fs.mkdir(build);
    await fs.writeFile(path.join(build, "index.html"), "<main>built app</main>");
    await fs.writeFile(path.join(root, "private.txt"), "outside build");
    await fs.symlink(path.join(root, "private.txt"), path.join(build, "link.txt"));
    await fs.mkdir(path.join(root, "private"));
    await fs.writeFile(path.join(root, "private/value.txt"), "outside directory");
    await fs.symlink(path.join(root, "private"), path.join(build, "linked-directory"), "dir");
    server = await serveNativeProductionAssets(build);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(server.url)).text()).toBe("<main>built app</main>");
    expect((await fetch(server.url + "/..%2fprivate.txt")).status).toBe(403);
    expect((await fetch(server.url + "/link.txt")).status).toBe(404);
    expect((await fetch(server.url + "/linked-directory/value.txt")).status).toBe(404);
    expect((await fetch(server.url + "/apps/desktop/src/renderer/main.tsx")).status).toBe(404);
    expect((await fetch(server.url, { method: "POST", body: "mutation" })).status).toBe(405);
  } finally { await server?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
