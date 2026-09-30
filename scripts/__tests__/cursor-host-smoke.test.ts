import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SMOKE = path.join(ROOT, "scripts/cursor-host-smoke.mjs");
const HOST = path.join(
  ROOT,
  "apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
);
const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

async function listen(server: Server) {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function stopSmoke(child: ChildProcess) {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {}
}

async function runSmoke(
  runtime: "Node" | "Electron",
  environment: NodeJS.ProcessEnv,
) {
  const child = spawn(
    process.execPath,
    [SMOKE, ...(runtime === "Electron" ? ["--electron"] : [])],
    {
      cwd: ROOT,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CURSOR_API_KEY: "",
        ZEROS_CURSOR_HOST_SCRIPT: HOST,
        ZEROS_CURSOR_SDK_ENTRY: "",
        ZEROS_PTY_HOST_RUNTIME: "",
        ZEROS_PTY_HOST_RUNTIME_ELECTRON: "",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ...environment,
      },
    },
  );
  let output = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    stopSmoke(child);
  }, 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, output, timedOut };
  } finally {
    clearTimeout(timer);
    stopSmoke(child);
  }
}

describe("Cursor host smoke", () => {
  it.each(["Node", "Electron"] as const)(
    "runs the %s probe without contacting the configured backend",
    async (runtime) => {
      const requests: string[] = [];
      const backend = await listen(
        createServer((request, response) => {
          requests.push(`${request.method} ${request.url}`);
          if (request.url === "/v1/models") {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid smoke key" }));
          }
        }),
      );

      const result = await runSmoke(runtime, { CURSOR_BACKEND_URL: backend });

      expect(result.timedOut, result.output).toBe(false);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("✓ PASS");
      expect(result.output).toContain("Curated cursor model ids NOT verified");
      expect(requests).toEqual([]);
    },
  );

  it.each([false, true])(
    "qualifies live catalogs with a key (missing required model: %s)",
    async (missingRequiredModel) => {
      const catalog = JSON.parse(
        readFileSync(path.join(ROOT, "catalogs/models-v1.json"), "utf8"),
      ) as {
        families: { cursor: { value: string; liveRequired?: boolean }[] };
      };
      const requiredModel = catalog.families.cursor.find(
        (model) => model.liveRequired !== true,
      );
      if (!requiredModel) throw new Error("No required Cursor model to qualify");
      const items = catalog.families.cursor
        .filter(
          (model) =>
            !missingRequiredModel || model.value !== requiredModel.value,
        )
        .map((model) => ({ id: model.value, displayName: model.value }));
      const requests: string[] = [];
      const backend = await listen(
        createServer((request, response) => {
          requests.push(`${request.method} ${request.url}`);
          response.setHeader("content-type", "application/json");
          if (request.url === "/v1/models") {
            response.end(JSON.stringify({ items }));
          } else {
            response.writeHead(401);
            response.end(JSON.stringify({ error: "invalid smoke key" }));
          }
        }),
      );

      const result = await runSmoke("Node", {
        CURSOR_API_KEY: "key_cursor_smoke_fixture",
        CURSOR_BACKEND_URL: backend,
      });

      expect(result.timedOut, result.output).toBe(false);
      expect(result.code, result.output).toBe(missingRequiredModel ? 1 : 0);
      expect(result.output).toContain(
        missingRequiredModel
          ? `required curated cursor model "${requiredModel.value}" is NOT offered`
          : "Curated cursor model ids verified",
      );
      expect(requests).toContain("GET /v1/models");
    },
  );
});
