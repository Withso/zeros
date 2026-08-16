import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

import { app, BrowserWindow, nativeImage } from "electron";

import { startZerosBrowserService } from "../../apps/desktop/electron/browser/service";
import { encodeCodexBrowserUseFrame } from "../../apps/desktop/electron/codex-browser-use-pipe";
import { setMainWindow } from "../../apps/desktop/electron/ipc/events";
import { registerIframePickerCommands } from "../../apps/desktop/electron/ipc/iframe-picker";

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

app
  .whenReady()
  .then(async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "zeros-browser-smoke-artifacts-"),
    );
    const movedWorkspaceRoot = await mkdtemp(
      join(tmpdir(), "zeros-browser-smoke-workspace-"),
    );
    const landing = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        "<!doctype html><title>Approved cross-site landing</title><p>landed</p>",
      );
    });
    const landingPort = await listen(landing);
    const faviconPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const fixture = createServer((request, response) => {
      if (request.url === "/favicon.ico") {
        response.setHeader("content-type", "image/png");
        response.end(faviconPng);
        return;
      }
      if (request.url?.startsWith("/redirect-offsite")) {
        response.statusCode = 302;
        response.setHeader(
          "location",
          `http://127.0.0.1:${landingPort}/redirected`,
        );
        response.end();
        return;
      }
      if (request.url?.startsWith("/slow-download")) {
        response.setHeader("content-type", "application/octet-stream");
        response.setHeader(
          "content-disposition",
          'attachment; filename="slow-report.bin"',
        );
        response.write(Buffer.alloc(1_024, 7));
        setTimeout(() => response.end(Buffer.alloc(1_024, 9)), 5_000);
        return;
      }
      response.setHeader("content-type", "text/html");
      if (request.url?.startsWith("/slow")) {
        response.write("<!doctype html><title>Slow browser smoke</title>");
        setTimeout(() => response.end("<p>eventually loaded</p>"), 5_000);
        return;
      }
      response.end(`<!doctype html><title>Zeros browser smoke</title>
        <link rel="icon" href="/favicon.ico">
        <button aria-label="Pay now" onclick="document.querySelector('#result').textContent='paid'">Pay now</button>
        <button aria-label="Hover guarded" onmouseenter="if(!document.querySelector('#hover-cover')){const cover=document.createElement('button');const rect=this.getBoundingClientRect();cover.id='hover-cover';cover.textContent='Covered target';cover.style.cssText='position:fixed;z-index:9999;left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;height:'+rect.height+'px';cover.onclick=()=>document.querySelector('#result').textContent='wrong target';document.body.append(cover)}" onclick="document.querySelector('#result').textContent='original target'">Hover guarded</button>
        <a aria-label="Download slow report" href="/slow-download" download>Download slow report</a>
        <a aria-label="Follow offsite redirect" href="/redirect-offsite">Follow offsite redirect</a>
        <button aria-label="Visit another site" onclick="location.href='http://127.0.0.1:${landingPort}/landing'">Visit another site</button>
        <button aria-label="Visit blocked site" onclick="location.href='http://127.0.0.1:${landingPort}/blocked'">Visit blocked site</button>
        <input type="file" aria-label="Evidence file">
        <div style="height:2200px"></div>
        <div id="result"></div>
        <script>
          const role = new URLSearchParams(location.search).get('role');
          if (role === 'writer') localStorage.setItem('zeros-browser-smoke', 'private');
          if (role === 'reader') document.querySelector('#result').textContent = localStorage.getItem('zeros-browser-smoke') || 'isolated';
        </script>`);
    });
    let service: Awaited<ReturnType<typeof startZerosBrowserService>> | null =
      null;
    let iframeWindow: BrowserWindow | null = null;
    try {
      const fixturePort = await listen(fixture);
      const iframeShellPath = join(artifactRoot, "iframe-favicon-smoke.html");
      await writeFile(
        iframeShellPath,
        `<!doctype html><meta charset="utf-8"><script>
          window.__zerosFaviconEvents = [];
          require("electron").ipcRenderer.on("zeros:event", (_event, envelope) => {
            if (envelope?.name === "browser-frame-favicon") {
              window.__zerosFaviconEvents.push(envelope.payload);
            }
          });
        </script><iframe name="zeros-browser-ordinary-smoke" src="http://127.0.0.1:${fixturePort}/ordinary"></iframe>`,
        { mode: 0o600 },
      );
      iframeWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: false,
          nodeIntegration: true,
          sandbox: false,
        },
      });
      setMainWindow(iframeWindow);
      registerIframePickerCommands({ mainWindow: iframeWindow });
      await iframeWindow.loadFile(iframeShellPath);
      await assertEventually(
        async () =>
          Boolean(
            await iframeWindow?.webContents.executeJavaScript(
              `window.__zerosFaviconEvents.some((event) => event?.frameName === "zeros-browser-ordinary-smoke" && event?.pageUrl === "http://127.0.0.1:${fixturePort}/ordinary" && event?.faviconDataUrl?.startsWith("data:image/"))`,
              true,
            ),
          ),
        "Ordinary Browser iframe did not publish its favicon event.",
      );
      const ordinaryFrame = () =>
        iframeWindow?.webContents.mainFrame.framesInSubtree.find(
          (frame) => frame.name === "zeros-browser-ordinary-smoke",
        );
      const controlOrdinaryFrame = async (
        action: "navigate" | "back" | "forward" | "reload",
        url?: string,
      ) => {
        const response = (await iframeWindow?.webContents.executeJavaScript(
          `window.__zerosNativeControl(${JSON.stringify(action)}, ${JSON.stringify(url)})`,
          true,
        )) as { ok?: boolean; frameTreeNodeId?: number | null } | undefined;
        assert.equal(response?.ok, true);
        return response;
      };
      // Invoke through main's registered handler by exposing the same one-shot
      // bridge shape the production preload uses. This remains renderer-script
      // free: only the fixed action enum + bounded URL cross the boundary.
      await iframeWindow.webContents.executeJavaScript(
        `window.__zerosNativeControl = (action, url) => require("electron").ipcRenderer.invoke("zeros:invoke", { cmd: "browser:control-iframe", args: { frameName: "zeros-browser-ordinary-smoke", action, ...(url ? { url } : {}) } })`,
        true,
      );
      const firstControl = await controlOrdinaryFrame(
        "navigate",
        `http://127.0.0.1:${fixturePort}/ordinary-next`,
      );
      const firstFrameId = firstControl.frameTreeNodeId;
      assert(firstFrameId);
      await assertEventually(
        () => ordinaryFrame()?.url.endsWith("/ordinary-next") === true,
        "Ordinary Browser address navigation did not use its live frame.",
      );
      await controlOrdinaryFrame("back");
      await assertEventually(
        () => ordinaryFrame()?.url.endsWith("/ordinary") === true,
        "Ordinary Browser Back did not traverse live frame history.",
      );
      await controlOrdinaryFrame("forward");
      await assertEventually(
        () => ordinaryFrame()?.url.endsWith("/ordinary-next") === true,
        "Ordinary Browser Forward did not traverse live frame history.",
      );
      const reloadControl = await controlOrdinaryFrame("reload");
      assert.equal(reloadControl.frameTreeNodeId, firstFrameId);
      await assertEventually(
        () => ordinaryFrame()?.frameTreeNodeId === firstFrameId,
        "Ordinary Browser controls replaced their iframe frame-tree node.",
      );
      iframeWindow.close();
      iframeWindow = null;
      const confirmations: string[] = [];
      const states: Array<{
        status: string;
        tool?: string;
        browserSessionId: string;
        faviconDataUrl?: string;
      }> = [];
      service = await startZerosBrowserService({
        artifactRoot,
        onSessionState: (state) => states.push(state),
        onConfirmationRequest: (request) => {
          confirmations.push(request.category);
          queueMicrotask(() =>
            service?.respondToConfirmation(
              request.id,
              request.url.endsWith("/blocked") ? "deny" : "allow-once",
            ),
          );
        },
      });
      const request = async (
        path: string,
        body: unknown,
        token = service!.token,
      ) =>
        fetch(`${service!.baseUrl}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

      const denied = await request(
        "/v1/sessions/acquire",
        { version: 1, owner: owner("conversation-a", artifactRoot) },
        "wrong-token",
      );
      assert.equal(denied.status, 401);

      const acquired = await request("/v1/sessions/acquire", {
        version: 1,
        owner: owner("conversation-a", artifactRoot),
      });
      assert.equal(acquired.ok, true);
      const first = (await acquired.json()) as { browserSessionId: string };
      const reacquired = await request("/v1/sessions/acquire", {
        version: 1,
        owner: owner("conversation-a", artifactRoot),
      });
      assert.equal(
        ((await reacquired.json()) as { browserSessionId: string })
          .browserSessionId,
        first.browserSessionId,
      );
      const moved = await request("/v1/sessions/acquire", {
        version: 1,
        owner: owner("conversation-a", movedWorkspaceRoot),
      });
      assert.equal(
        ((await moved.json()) as { browserSessionId: string }).browserSessionId,
        first.browserSessionId,
      );
      const uploadPath = join(movedWorkspaceRoot, "evidence.txt");
      await writeFile(uploadPath, "browser upload evidence", { mode: 0o600 });

      const invoke = async (tool: string, args: unknown = {}) => {
        const response = await request(
          `/v1/sessions/${first.browserSessionId}/invoke`,
          { version: 1, tool, arguments: args },
        );
        assert.equal(response.ok, true);
        return (await response.json()) as {
          success: boolean;
          content: Array<{ type: string; text?: string; data?: string }>;
        };
      };
      const opened = await invoke("open", {
        url: `http://127.0.0.1:${fixturePort}/?role=writer`,
      });
      assert.equal(opened.success, true);
      const snapshot = JSON.parse(opened.content[0]!.text!) as {
        title: string;
        elements: Array<{ ref: string; name: string }>;
      };
      assert.equal(snapshot.title, "Zeros browser smoke");
      await assertEventually(
        () =>
          Boolean(
            states.find(
              (state) =>
                state.browserSessionId === first.browserSessionId &&
                state.faviconDataUrl?.startsWith("data:image/"),
            ),
          ),
        "Browser state did not publish the fixture favicon.",
      );
      const payRef = snapshot.elements.find(
        ({ name }) => name === "Pay now",
      )?.ref;
      const uploadRef = snapshot.elements.find(
        ({ name }) => name === "Evidence file",
      )?.ref;
      const hoverGuardedRef = snapshot.elements.find(
        ({ name }) => name === "Hover guarded",
      )?.ref;
      const slowDownloadRef = snapshot.elements.find(
        ({ name }) => name === "Download slow report",
      )?.ref;
      const offsiteRef = snapshot.elements.find(
        ({ name }) => name === "Visit another site",
      )?.ref;
      assert(payRef);
      assert(uploadRef);
      assert(hoverGuardedRef);
      assert(slowDownloadRef);
      assert(offsiteRef);
      assert.equal((await invoke("click", { ref: "b999999" })).success, false);
      assert.equal(states.at(-1)?.status, "ready");
      assert.equal(states.at(-1)?.tool, "click");
      assert.equal(
        (await invoke("click", { ref: hoverGuardedRef })).success,
        false,
      );
      const interruptedDownload = invoke("click", { ref: slowDownloadRef });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(service.stopBrowserAction(first.browserSessionId), true);
      assert.equal((await interruptedDownload).success, false);
      const paid = await invoke("click", { ref: payRef });
      assert.equal(paid.success, true);
      // Every successful mutating tool returns a new snapshot. A ref from the
      // preceding snapshot must fail even if the control remains in the same
      // DOM position and would otherwise receive the same numeric index.
      assert.equal(
        (await invoke("upload", { ref: uploadRef, path: uploadPath })).success,
        false,
      );
      const paidSnapshot = JSON.parse(paid.content[0]!.text!) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const currentUploadRef = paidSnapshot.elements.find(
        ({ name }) => name === "Evidence file",
      )?.ref;
      assert(currentUploadRef);
      const uploaded = await invoke("upload", {
        ref: currentUploadRef,
        path: uploadPath,
      });
      assert.equal(uploaded.success, true);
      const uploadedSnapshot = JSON.parse(uploaded.content[0]!.text!) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const currentOffsiteRef = uploadedSnapshot.elements.find(
        ({ name }) => name === "Visit another site",
      )?.ref;
      assert(currentOffsiteRef);
      const offsite = await invoke("click", { ref: currentOffsiteRef });
      assert.equal(offsite.success, true);
      assert.match(
        offsite.content[0]!.text ?? "",
        /Approved cross-site landing/,
      );
      const backFromOffsite = await invoke("back");
      assert.equal(backFromOffsite.success, true);
      const backSnapshot = JSON.parse(backFromOffsite.content[0]!.text!) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const redirectRef = backSnapshot.elements.find(
        ({ name }) => name === "Follow offsite redirect",
      )?.ref;
      assert(redirectRef);
      const redirected = await invoke("click", { ref: redirectRef });
      assert.equal(redirected.success, true);
      assert.match(
        redirected.content[0]!.text ?? "",
        /Approved cross-site landing/,
      );
      const backFromRedirect = await invoke("back");
      assert.equal(backFromRedirect.success, true);
      const redirectBackSnapshot = JSON.parse(
        backFromRedirect.content[0]!.text!,
      ) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const blockedRef = redirectBackSnapshot.elements.find(
        ({ name }) => name === "Visit blocked site",
      )?.ref;
      assert(blockedRef);
      assert.equal((await invoke("click", { ref: blockedRef })).success, false);
      assert.deepEqual(confirmations, [
        "navigation",
        "download",
        "payment",
        "file-upload",
        "navigation",
        "navigation",
        "navigation",
      ]);

      const scrolled = await invoke("scroll", { y: 600 });
      const scrolledSnapshot = JSON.parse(scrolled.content[0]!.text!) as {
        scroll: { y: number };
      };
      assert(scrolledSnapshot.scroll.y > 0);

      const screenshot = await invoke("screenshot");
      assert.equal(
        screenshot.content.some(({ type }) => type === "image"),
        true,
      );
      const screenshotBytes = Buffer.from(
        screenshot.content.find(({ type }) => type === "image")!.data!,
        "base64",
      );
      const topLeftPixel = nativeImage
        .createFromBuffer(screenshotBytes)
        .crop({ x: 4, y: 4, width: 1, height: 1 })
        .toBitmap();
      assert(
        topLeftPixel[0]! > 245 &&
          topLeftPixel[1]! > 245 &&
          topLeftPixel[2]! > 245,
        "browser evidence must not contain the cyan agent-working overlay",
      );
      assert.equal((await invoke("trace")).success, true);

      const second = await service.acquire(
        owner("conversation-b", artifactRoot),
      );
      const reader = await service.invoke({
        version: 1,
        browserSessionId: second.browserSessionId,
        tool: "open",
        arguments: { url: `http://127.0.0.1:${fixturePort}/?role=reader` },
      });
      assert.match(
        reader.content[0]!.type === "text" ? reader.content[0].text : "",
        /isolated/,
      );
      const released = await request("/v1/sessions/release", {
        version: 1,
        workspaceId: "workspace-smoke",
        conversationId: "conversation-b",
      });
      assert.deepEqual(await released.json(), { version: 1, released: true });
      assert.equal(
        (
          await service.invoke({
            version: 1,
            browserSessionId: second.browserSessionId,
            tool: "snapshot",
            arguments: {},
          })
        ).success,
        false,
      );

      const wrongDelete = await fetch(
        `${service.baseUrl}/v1/sessions/${first.browserSessionId}/invoke`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${service.token}` },
        },
      );
      assert.equal(wrongDelete.status, 404);
      assert.equal((await invoke("snapshot")).success, true);

      assert.equal(await service.revokeConfirmationSurface(), 0);
      assert.equal((await invoke("snapshot")).success, false);
      const afterSurfaceReset = await service.acquire(
        owner("conversation-a", movedWorkspaceRoot),
      );
      assert.equal(afterSurfaceReset.browserSessionId, first.browserSessionId);
      const reopened = await invoke("open", {
        url: `http://127.0.0.1:${fixturePort}/?role=reader`,
      });
      assert.match(
        reopened.content[0]!.type === "text" ? reopened.content[0].text : "",
        /isolated/,
      );

      // Native Codex IAB lifecycle: app-server turn completion must hand the
      // exact retained WebContents back even when node_repl never calls
      // tabs.finalize() (timeout/kernel reset). The settlement is idempotent,
      // and Stop's blocked turn remains blocked until a different turn starts.
      const nativeSessionId = "codex-smoke-thread";
      const registered = await request("/v1/providers/codex/register", {
        version: 1,
        browserSessionId: first.browserSessionId,
        nativeSessionId,
      });
      assert.deepEqual(await registered.json(), { registered: true });
      const nativeParams = {
        session_id: nativeSessionId,
        turn_id: "native-turn-1",
      };
      assert.equal(
        (
          await nativeBrowserRequest<{ type: string }>(
            service.codexBrowserUsePipePath,
            "getInfo",
            nativeParams,
          )
        ).result?.type,
        "iab",
      );
      assert(
        (
          await nativeBrowserRequest<{ id: number }>(
            service.codexBrowserUsePipePath,
            "createTab",
            nativeParams,
          )
        ).result?.id,
      );
      const settleNativeTurn = (browserSessionId = first.browserSessionId) =>
        request("/v1/providers/codex/turn-ended", {
          version: 1,
          browserSessionId,
          nativeSessionId,
        });
      assert.deepEqual(await (await settleNativeTurn()).json(), {
        version: 1,
        settled: true,
      });
      assert.deepEqual(await (await settleNativeTurn()).json(), {
        version: 1,
        settled: true,
      });
      const handedToUser = await nativeBrowserRequest<unknown[]>(
        service.codexBrowserUsePipePath,
        "getUserTabs",
        {
          session_id: nativeSessionId,
          turn_id: "native-turn-2",
        },
      );
      assert.equal(handedToUser.result?.length, 1);
      await settleNativeTurn();

      assert(
        (
          await nativeBrowserRequest<{ id: number }>(
            service.codexBrowserUsePipePath,
            "createTab",
            {
              session_id: nativeSessionId,
              turn_id: "native-turn-stopped",
            },
          )
        ).result?.id,
      );
      assert.equal(service.stopBrowserAction(first.browserSessionId), true);
      assert.deepEqual(await (await settleNativeTurn()).json(), {
        version: 1,
        settled: true,
      });
      assert.match(
        String(
          (
            await nativeBrowserRequest(
              service.codexBrowserUsePipePath,
              "getTabs",
              {
                session_id: nativeSessionId,
                turn_id: "native-turn-stopped",
              },
            )
          ).error?.message,
        ),
        /stopped by the user/,
      );
      const afterStoppedTurn = await nativeBrowserRequest<unknown[]>(
        service.codexBrowserUsePipePath,
        "getUserTabs",
        {
          session_id: nativeSessionId,
          turn_id: "native-turn-3",
        },
      );
      assert.equal(afterStoppedTurn.result?.length, 1);
      await settleNativeTurn();

      const interrupted = invoke("open", {
        url: `http://127.0.0.1:${fixturePort}/slow`,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(service.stopBrowserAction(first.browserSessionId), true);
      assert.equal((await interrupted).success, false);
      assert.equal(
        (
          await invoke("open", {
            url: `http://127.0.0.1:${fixturePort}/?role=reader`,
          })
        ).success,
        true,
      );

      const finalized = await invoke("close");
      assert.equal(finalized.success, true);
      assert.match(finalized.content[0]!.text ?? "", /"retained":true/);
      const handedOff = await invoke("snapshot");
      assert.equal(handedOff.success, true);
      assert.match(handedOff.content[0]!.text ?? "", /Zeros browser smoke/);

      assert.equal(await service.clearBrowsingData(), 1);
      assert.equal((await invoke("snapshot")).success, false);

      const closed = await fetch(
        `${service.baseUrl}/v1/sessions/${first.browserSessionId}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${service.token}` },
        },
      );
      assert.equal(closed.status, 204);
    } finally {
      if (iframeWindow && !iframeWindow.isDestroyed()) iframeWindow.close();
      if (service) await service.stop();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await new Promise<void>((resolve) => landing.close(() => resolve()));
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(movedWorkspaceRoot, { recursive: true, force: true });
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

function owner(conversationId: string, workspaceRoot: string) {
  return {
    workspaceId: "workspace-smoke",
    conversationId,
    workspaceRoot,
  };
}

interface NativeBrowserResponse<T> {
  result?: T;
  error?: { message?: unknown };
}

async function nativeBrowserRequest<T = unknown>(
  pipePath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<NativeBrowserResponse<T>> {
  const socket = createConnection(pipePath);
  await Promise.race([
    once(socket, "connect"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  const response = new Promise<NativeBrowserResponse<T>>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timeout = setTimeout(
      () => reject(new Error(`Native Browser request timed out: ${method}`)),
      10_000,
    );
    timeout.unref?.();
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < 4) return;
      const length =
        endianness() === "LE"
          ? buffered.readUInt32LE(0)
          : buffered.readUInt32BE(0);
      if (buffered.byteLength < 4 + length) return;
      clearTimeout(timeout);
      try {
        resolve(
          JSON.parse(
            buffered.subarray(4, 4 + length).toString("utf8"),
          ) as NativeBrowserResponse<T>,
        );
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
  socket.write(
    encodeCodexBrowserUseFrame({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  );
  try {
    return await response;
  } finally {
    socket.destroy();
  }
}

async function assertEventually(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
