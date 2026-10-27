// Build/serve the real optimized renderer without installing test hooks in the
// shipped app. The qualification entry and app share one Rollup module graph.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { nativeProductionViteConfiguration } from "./design-native-vite.mjs";

const designModuleExports = Object.fromEntries(Object.entries({
  "state/projects-store.ts": ["upsertProject", "loadProjects", "syncProjectsToEngine"],
  "state/use-projects.ts": ["notifyProjectsChanged", "notifyWorkspacesChanged", "reloadWorkspacesFor", "peekWorkspacesFor"],
  "state/workspace-store.ts": ["useWorkspaceStore"],
  "platform/git.ts": ["workspaceAdoptExisting"],
  "platform/bridge/active-bridge.ts": ["getActiveBridge"],
  "platform/bridge/design-bridge.ts": ["bridgeDesignFrame", "bridgeDesignPreview"],
  "shell/workbench/tab-model.ts": ["defaultScopeFor"],
  "features/team/active-team.ts": ["setActiveOrganizationSelection"],
  "features/team/team-store.ts": ["refreshTeams", "getTeamStoreState", "getActiveOrganizationSnapshot"],
  "features/auth/auth-store.ts": ["getSession"],
  "features/design-workspace/state/design-workspace-ui.ts": ["useDesignWorkspaceUiStore"],
  "features/design-workspace/state/design-workspace-cache.ts": ["designWorkspaceSnapshotCache"],
  "features/design-workspace/design-source-vector.ts": ["designSourceVectorCache"],
  "features/design-workspace/state/design-renderer-resources.ts": ["designRendererResources"],
}).map(([file, names]) => [`/apps/desktop/src/renderer/${file}`, names]));
export const nativeDesignModules = Object.keys(designModuleExports);

export function productionProbeSource(sourceRoot, moduleExports = designModuleExports) {
  const modules = Object.entries(moduleExports);
  // A namespace import eagerly materializes re-exported constants in Rollup's
  // shared chunks. Valid application cycles can then fail during startup.
  // Named live bindings plus getters read only after module initialization.
  return modules.map(([file, names], i) => `import {${names.map((name, j) => `${name} as m${i}_${j}`).join(",")}} from ${JSON.stringify(path.join(sourceRoot, file.slice(1)))};`).join("\n") +
    `\nexport const build = { mode: import.meta.env.MODE, development: import.meta.env.DEV };\nexport const modules = {\n` +
    modules.map(([file, names], i) => `${JSON.stringify(file)}:{${names.map((name, j) => `get ${JSON.stringify(name)}(){return m${i}_${j};}`).join(",")}}`).join(",\n") + "\n};\n";
}

export async function buildNativeProduction({ repo, root, env, run }) {
  // Repeated isolated builds and raw traces can fill the operator's disk.
  // Refuse before creating output or starting a compiler, leaving headroom
  // for the run's evidence and the host's own work. Never delete prior runs.
  const disk = await fs.statfs(root), diskFreeBytes = disk.bavail * disk.bsize;
  if (!Number.isSafeInteger(diskFreeBytes) || diskFreeBytes < 4 * 1024 ** 3)
    throw new Error("Native qualification needs at least 4 GiB free for its isolated build and trace evidence. Reclaim retired generated builds before retrying.");
  const stage = path.join(root, "app"); await fs.mkdir(stage);
  for (const directory of ["node_modules", "apps", "packages", "resources", "styles"]) {
    try { await fs.access(path.join(repo, directory)); await fs.symlink(path.join(repo, directory), path.join(stage, directory), "dir"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await fs.copyFile(path.join(repo, "package.json"), path.join(stage, "package.json"));
  await fs.mkdir(path.join(stage, "scripts"));
  await fs.copyFile(path.join(repo, "scripts/build-sidecar.mjs"), path.join(stage, "scripts/build-sidecar.mjs"));
  await fs.writeFile(path.join(root, "engine-build.log"), await run(process.execPath, [path.join(stage, "scripts/build-sidecar.mjs")], { env }));
  await fs.writeFile(path.join(root, "main-build.log"), await run("pnpm", ["exec", "tsup", "--config", "apps/desktop/electron/tsup.config.ts", "--out-dir", path.join(stage, "dist-electron")], { env }));
  // Without cli.ts the existing native resolver selects this run's compiled
  // sidecar. Unlink only the symlink we just created; source stays untouched.
  await fs.unlink(path.join(stage, "apps"));
  await fs.mkdir(path.join(stage, "apps/desktop/src"), { recursive: true });
  await fs.symlink(path.join(repo, "apps/desktop/src/engine"), path.join(stage, "apps/desktop/src/engine"), "dir");
  const probe = path.join(root, "qualification.ts");
  await fs.writeFile(probe, productionProbeSource(repo), { flag: "wx" });
  const config = path.join(root, "vite.config.mjs"), output = path.join(stage, "dist");
  await fs.writeFile(config, nativeProductionViteConfiguration(repo, path.join(root, "vite-cache"), output, probe));
  await fs.writeFile(path.join(root, "renderer-build.log"), await run("pnpm", ["exec", "vite", "build", "--mode", "production", "--config", config], { env: { ...env, NODE_ENV: "production" } }));
  const manifest = JSON.parse(await fs.readFile(path.join(output, ".vite/manifest.json"), "utf8"));
  const entry = Object.values(manifest).find(item => item.isEntry && item.name === "qualification");
  if (!entry || typeof entry.file !== "string" || !entry.file.startsWith("assets/")) throw new Error("Production qualification entry is missing.");
  return { stage, output, modulePath: entry.file, diskFreeBytes };
}

/** Loopback-only immutable build assets. No directory listing, source endpoint,
 * dev transform, HMR socket, credentials or runtime control endpoint. */
export async function serveNativeProductionAssets(root, port = 0) {
  const base = await fs.realpath(root);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
  const server = createServer(async (request, response) => {
    let fd;
    try {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
      const relative = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "") || "index.html";
      const file = path.resolve(base, relative);
      if (!file.startsWith(base + path.sep) || relative.split(/[\\/]/).some(part => part.startsWith("."))) { response.writeHead(403).end(); return; }
      // The isolated immutable build owns every directory. Reject a linked
      // parent too; O_NOFOLLOW alone checks only the final path component.
      if (await fs.realpath(file) !== file) { response.writeHead(404).end(); return; }
      fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 ** 2) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : await fd.readFile());
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
    finally { await fd?.close(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
