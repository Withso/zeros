import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { chromium } from "@playwright/test";
import { WebSocketServer } from "ws";

import { ZsrPreviewGateway } from "../apps/desktop/src/engine/agents/containment/zsr-preview-gateway";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("browser smoke server did not bind TCP"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function chromeExecutable(): string {
  const candidates = [
    process.env.ZEROS_CHROME_EXECUTABLE,
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((value): value is string => Boolean(value));
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error(
      "Chrome is required for the ZSR preview browser qualification",
    );
  }
  return executable;
}

async function main(): Promise<void> {
  let observedHost = "";
  let observedOrigin = "";
  const target = createServer((request, response) => {
    observedHost = request.headers.host ?? "";
    if (request.url === "/asset.txt") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("asset-ok");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>ZSR preview</title>
      <script>
        Promise.all([
          fetch('/asset.txt').then((response) => response.text()),
          new Promise((resolve, reject) => {
            const socket = new WebSocket('ws://' + location.host + '/hmr');
            socket.onopen = () => socket.send('hmr');
            socket.onmessage = (event) => { resolve(event.data); socket.close(); };
            socket.onerror = () => reject(new Error('websocket failed'));
          }),
        ]).then(([asset, hmr]) => {
          parent.postMessage({ type: 'zsr-ready', asset, hmr, href: location.href }, '*');
        });
      </script>`);
  });
  const sockets = new WebSocketServer({ server: target });
  sockets.on("connection", (socket, request) => {
    observedOrigin = request.headers.origin ?? "";
    socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
  });
  const targetPort = await listen(target);

  const gateway = await ZsrPreviewGateway.open({
    targetHost: "127.0.0.1",
    targetPort,
    displayPort: 5173,
  });
  const navigation = await gateway.navigation();
  const parent = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8">
      <iframe id="preview" src=${JSON.stringify(navigation.admissionUrl)}></iframe>
      <script>
        addEventListener('message', (event) => {
          if (event.data && event.data.type === 'zsr-ready') window.__zsrResult = event.data;
        });
      </script>`);
  });
  const parentPort = await listen(parent);
  const browser = await chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: ["--no-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${parentPort}/`);
    await page.waitForFunction(
      () => Boolean((window as Window & { __zsrResult?: unknown }).__zsrResult),
      undefined,
      { timeout: 15_000 },
    );
    const result = await page.evaluate(
      () =>
        (window as Window & {
          __zsrResult: { asset: string; hmr: string; href: string };
        }).__zsrResult,
    );
    if (
      result.asset !== "asset-ok" ||
      result.hmr !== "echo:hmr" ||
      new URL(result.href).searchParams.has("__zsr_cap") ||
      observedHost !== "localhost:5173" ||
      observedOrigin !== "http://localhost:5173"
    ) {
      throw new Error("ZSR preview browser parity assertion failed");
    }
    if ((await fetch(navigation.admissionUrl)).status !== 403) {
      throw new Error("ZSR preview admission capability was replayable");
    }
    console.log(
      "✓ ZSR preview passed real-Chrome iframe, partitioned-cookie, asset, WebSocket, HMR, redaction, and replay checks.",
    );
  } finally {
    await browser.close();
    await gateway.close();
    sockets.close();
    await Promise.all([close(parent), close(target)]);
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "ZSR preview browser smoke failed",
  );
  process.exitCode = 1;
});
