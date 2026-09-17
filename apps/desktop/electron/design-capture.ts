import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import {
  startDesignCaptureService,
  type DesignCaptureService,
} from "../src/engine/design/capture-service";
import {
  sanitizeDesignFrameMarkup,
  insertDesignHeadMarkup,
} from "../src/engine/design/source";

/** An on-demand invisible authored renderer. This partition is never shared
 * with browser-use sessions, the app renderer, or user cookies. Each capture
 * owns and destroys its window; a closed Design canvas is not required. */
export async function startElectronDesignCapture(): Promise<DesignCaptureService> {
  const partition = session.fromPartition(
    `zeros-design-capture-${randomUUID()}`,
    { cache: false },
  );
  partition.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  partition.setPermissionCheckHandler(() => false);
  partition.on("will-download", (event) => event.preventDefault());
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !details.url.startsWith("data:") && details.url !== "about:blank",
    });
  });
  const service = await startDesignCaptureService(async (input, signal) => {
    signal.throwIfAborted();
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: input.width,
      height: input.height,
      useContentSize: true,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        // The host evaluates readiness. Authored execution is independently
        // disabled by sanitization and a leading script-src 'none' policy.
        javascript: true,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: false,
        safeDialogs: true,
        devTools: false,
        spellcheck: false,
      },
    });
    const destroy = () => {
      if (!window.isDestroyed()) window.destroy();
    };
    signal.addEventListener("abort", destroy, { once: true });
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"><style>*,:before,:after{animation:none!important;transition:none!important;caret-color:transparent!important}html{color-scheme:${input.colorScheme}}</style>`;
      const html = insertDesignHeadMarkup(
        sanitizeDesignFrameMarkup(input.html),
        policy,
      );
      await window.loadURL(
        `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`,
      );
      signal.throwIfAborted();
      // Scope media preferences to this disposable page. Setting CSS
      // color-scheme alone does not change authored prefers-* media queries.
      // Navigate first: Electron may defer debugger commands before navigation.
      window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand(
        "Emulation.setEmulatedMedia",
        {
          media: "screen",
          features: [
            { name: "prefers-color-scheme", value: input.colorScheme },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        },
      );
      signal.throwIfAborted();
      // Evaluation is host-authored; CSP forbids authored scripts. Decode data images/fonts before taking the exact viewport.
      await window.webContents.executeJavaScript(
        `Promise.all([document.fonts.ready,...Array.from(document.images, image => image.decode().catch(()=>{}))]).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`,
      );
      signal.throwIfAborted();
      const captured = await window.webContents.capturePage(
        { x: 0, y: 0, width: input.width, height: input.height },
        { stayHidden: true, stayAwake: false },
      );
      signal.throwIfAborted();
      const size = captured.getSize();
      const image =
        size.width === input.width && size.height === input.height
          ? captured
          : captured.resize({
              width: input.width,
              height: input.height,
              quality: "best",
            });
      return {
        bytes: image.toPNG(),
        renderer: `electron-${process.versions.electron}/chromium-${process.versions.chrome}`,
      };
    } finally {
      signal.removeEventListener("abort", destroy);
      destroy();
      await partition.clearStorageData();
    }
  });
  return service;
}
