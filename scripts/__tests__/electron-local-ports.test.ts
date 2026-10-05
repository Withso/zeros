import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkoutIdentity,
  pickLocalPorts,
  runLocalDevelopment,
  runOwnedProcess,
} from "../electron-local.mjs";

const roots: string[] = [];
function directory() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-port-test-")),
  );
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const ports = { vitePort: 6200, engineBase: 31000 };
const ready =
  "[vite] VITE v7.3.1 ready in 123 ms\n[app] [Zeros] engine ready and externally verified on port 31000\n";
const viteCollision =
  "[vite] error when starting dev server:\n[vite] Error: Port 6200 is already in use\n";
const engineCollision =
  "[app] [engine]   Failed to start engine: Error: listen EADDRINUSE: address already in use 127.0.0.1:31007\n";

async function outputResult(
  output: string,
  startup = ports,
  timeoutMs = 1000,
  lateOutput?: string,
) {
  const script = `process.stdout.write(${JSON.stringify(output)});${lateOutput ? `setTimeout(()=>process.stdout.write(${JSON.stringify(lateOutput)}),100);` : ""}setTimeout(()=>process.exit(0),200);`;
  return runOwnedProcess(process.execPath, ["-e", script], {
    cwd: directory(),
    env: process.env,
    killGraceMs: 100,
    output: () => {},
    startup: { ...startup, timeoutMs },
  });
}

describe("Local startup bind races", () => {
  it("does not treat ordinary EADDRINUSE diagnostics as a startup collision", async () => {
    expect(
      (
        await outputResult(
          "[app] Diagnostic: the EADDRINUSE retry regression is covered\n",
        )
      ).code,
    ).toBe(0);
  });
  it.each([viteCollision, engineCollision])(
    "retries an owned startup bind failure: %s",
    async (output) => {
      expect((await outputResult(output)).code).toBe(98);
    },
  );
  it.each([viteCollision, engineCollision])(
    "disarms after both ready markers: %s",
    async (output) => {
      expect((await outputResult(ready, ports, 1000, output)).code).toBe(0);
    },
  );
  it("stays armed until both Vite and engine are ready", async () => {
    expect(
      (
        await outputResult(
          "[vite] VITE v7.3.1 ready in 123 ms\n",
          ports,
          1000,
          engineCollision,
        )
      ).code,
    ).toBe(98);
  });
  it("disarms at the bounded startup deadline", async () => {
    expect((await outputResult("", ports, 50, engineCollision)).code).toBe(0);
  });
  it("ignores other ports, including the MCP gateway", async () => {
    expect(
      (await outputResult(viteCollision.replaceAll("6200", "6201"))).code,
    ).toBe(0);
    expect(
      (await outputResult(engineCollision.replaceAll("31007", "31008"))).code,
    ).toBe(0);
  });

  it("excludes failed Vite ports and every port in failed engine blocks before probing", async () => {
    const probed: number[] = [];
    const probe = async (port: number) => {
      probed.push(port);
      return true;
    };
    const first = await pickLocalPorts("test", 0, { portFree: probe });
    const excluded = new Set([
      first.vitePort,
      ...Array.from({ length: 10 }, (_, i) => first.engineBase + i),
    ]);
    probed.length = 0;
    const second = await pickLocalPorts("test", 0, {
      portFree: probe,
      excluded,
    });
    expect(second.vitePort).not.toBe(first.vitePort);
    expect(second.engineBase).not.toBe(first.engineBase);
    expect(probed.some((port) => excluded.has(port))).toBe(false);
  });

  it("never repeats failed ports even when retry hashes collide and the prober always says free", async () => {
    const parent = directory();
    const digest = (value: string) =>
      createHash("sha256").update(value).digest();
    let root = "";
    for (let candidate = 0; candidate < 10000; candidate++) {
      const value = path.join(parent, `checkout-${candidate}`);
      const slug = digest(value).toString("hex").slice(0, 16);
      const slots = [0, 1, 2].map(
        (attempt) => digest(`${slug}:${attempt}`).readUInt32BE(0) % 1024,
      );
      if (new Set(slots).size < 3) {
        root = value;
        break;
      }
    }
    expect(root).not.toBe("");
    fs.mkdirSync(root);
    const attempted: Array<typeof ports> = [],
      probed: number[] = [];
    await runLocalDevelopment({
      root,
      platform: "darwin",
      environment: {},
      listProcesses: () => "",
      prepareBundle: () => "/fake/Electron",
      portProber: async (port: number) => {
        probed.push(port);
        return true;
      },
      run: async (
        _command: string,
        args: string[],
        options: { env: Record<string, string> },
      ) => {
        if (args.includes("concurrently")) {
          const current = {
            vitePort: Number(options.env.ZEROS_VITE_PORT),
            engineBase: Number(options.env.ZEROS_ENGINE_BASE_PORT),
          };
          for (const previous of attempted) {
            expect(current.vitePort).not.toBe(previous.vitePort);
            expect(current.engineBase).not.toBe(previous.engineBase);
            expect(probed).not.toContain(previous.vitePort);
            for (let offset = 0; offset < 10; offset++)
              expect(probed).not.toContain(previous.engineBase + offset);
          }
          attempted.push(current);
          probed.length = 0;
          return { code: 98, cancelled: false };
        }
        return { code: 0, cancelled: false };
      },
    });
    expect(checkoutIdentity(root).slug).toHaveLength(16);
    expect(attempted).toHaveLength(3);
  });
});
