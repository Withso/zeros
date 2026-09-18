import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engineRuntimeDir } from "../../src/engine/db/paths";
import {
  engineTurnIsActive,
  installDevMainRestartCheck,
} from "../dev-main-restart";

let root: string;
const disposers: Array<() => void> = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-restart-check-"));
  vi.stubEnv("ZEROS_DATA_DIR", path.join(root, "data"));
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function marker(at = Date.now()) {
  const directory = engineRuntimeDir(root);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "busy");
  await writeFile(file, "1");
  await utimes(file, at / 1000, at / 1000);
  return file;
}

function harness(enabled = true) {
  const port = Object.assign(new EventEmitter(), { send: vi.fn() });
  const quit = vi.fn();
  const currentRoot = vi.fn<() => string | null>(() => root);
  const dispose = installDevMainRestartCheck({
    enabled,
    port: port as unknown as Pick<NodeJS.Process, "on" | "off" | "send">,
    currentRoot,
    quit,
  });
  disposers.push(dispose);
  const check = (requestId = 1) => {
    port.emit("message", { type: "zeros:dev-main-restart-check", requestId });
    return port.send.mock.lastCall?.[0];
  };
  return { port, quit, currentRoot, check, dispose };
}

describe("development restart readiness", () => {
  it("waits for startup and the exact engine's active turn, then reports idle", async () => {
    const app = harness();
    app.currentRoot.mockReturnValue(null);
    expect(app.check()).toMatchObject({ requestId: 1, busy: true });
    app.currentRoot.mockReturnValue(root);
    const file = await marker();
    expect(app.check(2)).toMatchObject({ requestId: 2, busy: true });
    expect(engineTurnIsActive(path.join(root, "sibling"))).toBe(false);
    await rm(file);
    expect(app.check(3)).toMatchObject({ requestId: 3, busy: false });
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("keeps a refreshed long-running turn busy and expires an abandoned heartbeat", async () => {
    const start = Date.now();
    const file = await marker(start);
    expect(engineTurnIsActive(root, start + 30_001)).toBe(false);
    const tenMinutesLater = start + 10 * 60_000;
    await utimes(file, tenMinutesLater / 1000, tenMinutesLater / 1000);
    expect(engineTurnIsActive(root, tenMinutesLater + 10_000)).toBe(true);
  });

  it("uses normal app quit for a supervisor termination and removes its listeners", () => {
    const app = harness();
    app.port.emit("SIGTERM");
    expect(app.quit).toHaveBeenCalledOnce();
    app.dispose();
    app.port.emit("SIGTERM");
    app.check();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.port.send).not.toHaveBeenCalled();
  });

  it("does not install production handlers or accept malformed parent messages", () => {
    const disabled = harness(false);
    disabled.check();
    expect(disabled.port.listenerCount("SIGTERM")).toBe(0);
    expect(disabled.port.send).not.toHaveBeenCalled();
    const app = harness();
    for (const message of [
      null,
      [],
      {},
      { type: "other", requestId: 1 },
      { type: "zeros:dev-main-restart-check", requestId: "1" },
      { type: "zeros:dev-main-restart-check", requestId: 0 },
    ]) {
      app.port.emit("message", message);
    }
    expect(app.port.send).not.toHaveBeenCalled();
  });
});
