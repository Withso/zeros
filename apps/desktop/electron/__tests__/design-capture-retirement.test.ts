import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { expect, it } from "vitest";
import type { ElectronApplication } from "@playwright/test";

const { launchNativeElectron } = createRequire(import.meta.url)(
  "../../../../scripts/design-native-electron.mjs",
);

// Real native windows require macOS or a display server; headless Electron's
// process-only mode cannot qualify BrowserWindow destruction.
it.runIf(process.platform === "darwin" || Boolean(process.env.DISPLAY))(
  "joins native destruction when a cancelled page evaluation never settles",
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "zeros-capture-retirement-"),
    );
    const entry = path.join(root, "probe.cjs");
    let app: ElectronApplication | undefined;
    try {
      await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
        const { app, BrowserWindow } = require("electron");
        const { startElectronDesignCapture } = require("./apps/desktop/electron/design-capture");
        const { electronDesignCaptureAdmission } = require("./apps/desktop/electron/design-capture-admission");
        const { randomUUID } = require("node:crypto");
        app.setName("Zeros Capture Retirement Test");
        app.setPath("userData", ${JSON.stringify(root)});
        app.on("window-all-closed", () => {});
        const keepAlive = setInterval(() => {}, 1000);
        app.on("will-quit", () => clearInterval(keepAlive));
        globalThis.captureRetirementProbe = async () => {
          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
          let entered = false, held = false, evaluationSettled = false, acknowledged = false, postSettled = false;
          // Hold the real renderer at the host's readiness evaluation. Destroying
          // WebContents can leave executeJavaScript's promise unresolved.
          const observe = (_event, contents) => {
            const execute = contents.executeJavaScript.bind(contents);
            contents.executeJavaScript = (code, ...args) => {
              if (!held && code.includes("document.fonts.ready")) {
                held = true;
                const pending = execute("globalThis.__captureReadinessHeld = true; new Promise(() => {})", ...args);
                pending.then(() => { evaluationSettled = true; }, () => { evaluationSettled = true; });
                void execute("globalThis.__captureReadinessHeld === true").then(value => { entered = value; });
                return pending;
              }
              return execute(code, ...args);
            };
          };
          app.on("web-contents-created", observe);
          const service = await startElectronDesignCapture();
          const job = randomUUID();
          const headers = { Authorization: "Bearer " + service.token, "Content-Type": "application/json",
            "X-Zeros-Design-Job": job, "X-Zeros-Design-Deadline": String(Date.now() + 20000) };
          const post = fetch(service.url + "/capture", { method: "POST", headers,
            body: JSON.stringify({ version: 1, revision: "held-readiness", width: 320, height: 240, html: "<body>Capture</body>" })
          }).then(async response => { await response.arrayBuffer(); postSettled = true; });
          const until = Date.now() + 5000;
          while (!entered && Date.now() < until) await delay(10);
          if (!entered) throw new Error("The native readiness gate was never reached.");
          const cancel = fetch(service.url + "/capture/" + job, { method: "DELETE", headers })
            .then(async response => { acknowledged = response.ok && (await response.json()).settled === true; });
          await Promise.race([Promise.all([post, cancel]), delay(1500)]);
          app.removeListener("web-contents-created", observe);
          let recovered = false;
          if (acknowledged && postSettled) {
            const next = await fetch(service.url + "/capture", { method: "POST",
              headers: { ...headers, "X-Zeros-Design-Job": randomUUID() }, signal: AbortSignal.timeout(3000),
              body: JSON.stringify({ version: 1, revision: "after-cancellation", width: 320, height: 240, html: "<body>Recovered</body>" }) });
            recovered = next.ok; await next.arrayBuffer();
          }
          const result = { entered, evaluationSettled, acknowledged, postSettled,
            recovered, windows: BrowserWindow.getAllWindows().length, admission: electronDesignCaptureAdmission.usage() };
          if (acknowledged && postSettled) await service.stop();
          return result;
        };
      `,
        },
        outfile: entry,
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        logLevel: "silent",
      });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await launchNativeElectron({
        args: [
          entry,
          ...(process.platform === "linux" ? ["--disable-gpu"] : []),
        ],
        env,
        timeout: 15_000,
      });
      const result = await app!.evaluate(async () =>
        (
          globalThis as typeof globalThis & {
            captureRetirementProbe(): Promise<unknown>;
          }
        ).captureRetirementProbe(),
      );
      expect(result).toMatchObject({
        entered: true,
        acknowledged: true,
        postSettled: true,
        recovered: true,
        windows: 0,
        admission: { running: 0, reservedBytes: 0 },
      });
    } finally {
      await app?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  25_000,
);
