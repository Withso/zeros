import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import { runInNewContext } from "node:vm";
import { request } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createServer, resolveConfig } from "vite";
import { createShowcaseServer } from "../showcase-server.mjs";
import { developmentServerOptions } from "../dev-server-policy.mjs";

const root = process.cwd();
const hostRequest = (url: string) => new Promise<number>((resolve, reject) => {
  const req = request(url, { headers: { Host: "untrusted.example" } }, res => { res.resume(); resolve(res.statusCode!); });
  req.on("error", reject); req.end();
});
describe("development file serving", () => {
  it("requires exact hosts for an explicitly shared preview", () => {
    expect(() => developmentServerOptions([], { ZEROS_DEV_BIND_HOST: "0.0.0.0" })).toThrow();
    expect(() => developmentServerOptions([], { ZEROS_DEV_BIND_HOST: "0.0.0.0", ZEROS_DEV_PREVIEW_HOSTS: ".example.test" })).toThrow();
    expect(developmentServerOptions([], { ZEROS_DEV_BIND_HOST: "0.0.0.0", ZEROS_DEV_PREVIEW_HOSTS: "preview.example.test" }).allowedHosts).toEqual(["preview.example.test"]);
  });

  it("serves only showcase assets without directory listings, private files or escaped symlinks", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "zeros-showcase-"));
    const publicRoot = path.join(fixture, "assets");
    await mkdir(publicRoot);
    await writeFile(path.join(publicRoot, "loaders-preview.html"), "<p>showcase</p>");
    await writeFile(path.join(fixture, ".env.agent"), "synthetic-private-canary");
    await symlink(path.join(fixture, ".env.agent"), path.join(publicRoot, "alias.html"));
    const server = createShowcaseServer(publicRoot);
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      for (const url of ["/.env.agent", "/zeros-dev-env.json", "/.context/", "/%2e%2e/.env.agent", "/alias.html", "/nested/"]) {
        const response = await fetch(origin + url);
        expect(response.status, url).toBeGreaterThanOrEqual(400);
        expect(await response.text()).not.toContain("synthetic-private-canary");
      }
      expect(await (await fetch(origin + "/styles/Artifacts/loaders-preview.html")).text()).toContain("showcase");
      expect(await hostRequest(origin)).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("refuses a showcase ancestor swapped after its path was checked", async () => {
    const fixture = fs.realpathSync(await mkdtemp(path.join(os.tmpdir(), "zeros-showcase-race-")));
    const publicRoot = path.join(fixture, "assets"), nested = path.join(publicRoot, "nested"), outside = path.join(fixture, "private");
    await mkdir(nested, { recursive: true }); await mkdir(outside);
    await writeFile(path.join(nested, "canary.html"), "public");
    await writeFile(path.join(outside, "canary.html"), "private-swap-canary");
    const server = createShowcaseServer(publicRoot);
    const realpath = fs.realpathSync;
    let swapped = false;
    const fault = vi.spyOn(fs, "realpathSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
      const resolved = realpath(file, options as never);
      if (String(file) === path.join(nested, "canary.html") && !swapped) {
        swapped = true; fs.renameSync(nested, `${nested}-saved`); fs.symlinkSync(outside, nested);
      }
      return resolved;
    }) as typeof fs.realpathSync);
    syncBuiltinESMExports();
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const response = await fetch(origin + "/nested/canary.html");
      expect(swapped).toBe(true);
      expect(await response.text()).not.toContain("private-swap-canary");
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      fault.mockRestore();
      syncBuiltinESMExports();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("serves the shared organization harness fixture without exposing neighboring scripts", async () => {
    const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] } });
    try {
      await server.listen();
      const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
      const fixture = await fetch(`${origin}/scripts/__tests__/fixtures/organization-list.json?import`);
      expect(fixture.status).toBe(200);
      expect(await fixture.text()).toContain("Membership 01");
      const adjacent = await fetch(`${origin}/scripts/dev-server-policy.mjs?import`);
      expect(adjacent.status).toBe(403);
      expect(await adjacent.text()).not.toContain("developmentFileBoundary");
    } finally { await server.close(); }
  });

  for (const app of ["desktop", "marketing"] as const) {
    const appRoot = app === "desktop" ? root : path.join(root, "apps/marketing");
    const configFile = path.join(appRoot, "vite.config.ts");
    it(`${app} defaults to a loopback bind and explicit host checks`, async () => {
      const config = await resolveConfig({ root: appRoot, configFile, logLevel: "silent" }, "serve");
      expect(["localhost", "127.0.0.1", "::1"]).toContain(config.server.host);
      expect(config.server.allowedHosts).not.toBe(true);
    });

    it(`${app} serves the trusted React refresh virtual module during normal development`, async () => {
      const server = await createServer({ root: appRoot, configFile, logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] } });
      try {
        await server.listen();
        const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
        const refresh = await fetch(`${origin}/@react-refresh`);
        expect(refresh.status).toBe(200);
        expect(await refresh.text()).toContain("injectIntoGlobalHook");
      } finally { await server.close(); }
    });

    it(`${app} retains Vite's private key and package credential exclusions`, async () => {
      const { isFileServingAllowed } = await import("vite");
      const server = await createServer({ root: appRoot, configFile, logLevel: "silent", server: { hmr: false, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] } });
      try {
        const allowedRoot = path.join(root, "node_modules");
        for (const file of [".npmrc", ".yarnrc.yml", "private.p12", "private.pfx", "private.cer", "private.der"])
          expect(isFileServingAllowed(path.join(allowedRoot, file), server), file).toBe(false);
      } finally { await server.close(); }
    });

    it(`${app} refuses private files including query, alias and symlink requests over HTTP`, async () => {
      // Clean checkouts do not inherit a workspace's private scratch directory.
      await mkdir(path.join(root, ".context"), { recursive: true, mode: 0o700 });
      const fixture = await mkdtemp(path.join(root, ".context/dev-serving-"));
      const canary = "synthetic-private-canary";
      const privateFile = path.join(fixture, "zeros-dev-env.json");
      await writeFile(privateFile, canary);
      await writeFile(path.join(fixture, ".env.agent"), canary);
      const linkRoot = app === "desktop" ? path.join(root, "apps/desktop/src/renderer") : path.join(appRoot, "public");
      const link = path.join(linkRoot, `security-canary-${path.basename(fixture)}.txt`);
      await symlink(privateFile, link);
      const server = await createServer({
        root: appRoot, configFile, logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
        resolve: { alias: { "private-canary": privateFile } },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      try {
        await server.listen();
        const address = server.httpServer!.address() as { port: number };
        const origin = `http://127.0.0.1:${address.port}`;
        const direct = `/@fs/${privateFile}`;
        const linkUrl = app === "desktop" ? `/${path.relative(root, link)}` : `/${path.basename(link)}`;
        for (const url of [direct, `${direct}?raw`, direct.replace(".context", "%2econtext"),
          `/@fs/${path.join(fixture, ".env.agent")}?import`, "/private-canary?raw", linkUrl,
          `${linkUrl}?raw`, `/@fs/${link}?raw`]) {
          const response = await fetch(origin + url);
          expect(await response.text(), url).not.toContain(canary);
        }
        expect(await hostRequest(origin)).toBe(403);
        expect((await fetch(origin + "/index.html")).status).toBe(200);
        if (app === "marketing") {
          const html = await (await fetch(origin + "/index.html")).text();
          const script = html.match(/<script>(if\(!\/\[\?&\]v=plain[\s\S]*?)<\/script>/)?.[1];
          expect(script).toBeDefined();
          const location = { href: `${origin}//untrusted.example/path`, search: "", replace: (value: string) => { expect(new URL(value).origin).toBe(origin); } };
          runInNewContext(script!, { URL, location });
        }
      } finally {
        await server.close();
        await rm(link, { force: true });
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }
});
