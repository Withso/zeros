import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";

import { app, BrowserWindow } from "electron";

import { startBrowserAutomationServer } from "../../apps/desktop/electron/browser-automation";

interface ToolResult {
  success?: boolean;
  contentItems?: Array<{ type?: string; text?: string }>;
}

async function browserUseRpc(
  path: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffered = Buffer.alloc(0);
    socket.once("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(
        new Error(
          `Browser Use RPC timed out: ${method}${typeof params.method === "string" ? `/${params.method}` : ""}`,
        ),
      );
    });
    socket.once("connect", () => {
      const body = Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      );
      const header = Buffer.alloc(4);
      if (endianness() === "LE") header.writeUInt32LE(body.byteLength, 0);
      else header.writeUInt32BE(body.byteLength, 0);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < 4) return;
      const length =
        endianness() === "LE"
          ? buffered.readUInt32LE(0)
          : buffered.readUInt32BE(0);
      if (buffered.byteLength < length + 4) return;
      socket.end();
      const reply = JSON.parse(
        buffered.subarray(4, length + 4).toString("utf8"),
      ) as Record<string, unknown>;
      if (reply.error) reject(new Error(JSON.stringify(reply.error)));
      else resolve(reply);
    });
  });
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

app
  .whenReady()
  .then(async () => {
    const progress = (stage: string) =>
      process.stderr.write(`browser-surface-smoke: ${stage}\n`);
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "zeros-browser-smoke-artifacts-"),
    );
    const fixture = createServer((request, response) => {
      if (request.url === "/download") {
        response.setHeader("content-type", "text/plain");
        response.setHeader(
          "content-disposition",
          'attachment; filename="browser-report.txt"',
        );
        response.end("downloaded browser evidence");
        return;
      }
      if (request.url === "/missing") {
        response.statusCode = 503;
        response.setHeader("content-type", "text/plain");
        response.end("intentional smoke failure");
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<!doctype html><title>Shared smoke</title>
        <button aria-label="Pay now" onclick="document.querySelector('#result').textContent='Payment complete'">Pay now</button>
        <label>Password <input type="password" /></label>
        <label>Evidence <input type="file" onchange="document.querySelector('#result').textContent=this.files[0]?.name||''" /></label>
        <a aria-label="Download report" href="/download" download>Download report</a>
        <button aria-label="Request notifications" onclick="Notification.requestPermission().then(value => document.querySelector('#result').textContent='permission:'+value)">Request notifications</button>
        <div id="result"></div>
        <script>
          console.error('smoke console failure'); fetch('/missing');
          const isolation = new URLSearchParams(location.search).get('isolation');
          if (isolation === 'writer') {
            document.cookie = 'browser-smoke-cookie=task-one; SameSite=Lax';
            document.querySelector('#result').textContent = 'writer:' + document.cookie;
          } else if (isolation === 'reader') {
            document.querySelector('#result').textContent = 'reader:' + document.cookie;
          }
        </script>`,
      );
    });
    let automation: Awaited<
      ReturnType<typeof startBrowserAutomationServer>
    > | null = null;
    let target: BrowserWindow | null = null;
    try {
      const fixturePort = await listen(fixture);
      const states: string[] = [];
      const sessionStates: Array<Record<string, unknown>> = [];
      let confirmation: { id: string; category: string; label: string } | null =
        null;
      automation = await startBrowserAutomationServer({
        artifactRoot,
        onSessionState: (state) => {
          states.push(`${state.status}:${state.taskId}`);
          sessionStates.push(state as unknown as Record<string, unknown>);
        },
        onConfirmationRequest: (request) => {
          confirmation = request;
        },
      });
      const nativeSession = {
        session_id: "codex-browser-use-smoke",
        turn_id: "codex-browser-use-turn",
        session_context: "live",
      };
      const registration = await fetch(
        automation.url.replace("/tool", "/codex-browser-use/register"),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${automation.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            taskId: "browser-use-smoke",
            sessionId: nativeSession.session_id,
          }),
        },
      );
      assert.equal(registration.ok, true);
      progress("Browser Use registered");
      const nativeInfo = await browserUseRpc(
        automation.codexBrowserUsePipePath,
        1,
        "getInfo",
        nativeSession,
      );
      assert.equal((nativeInfo.result as { type?: string }).type, "iab");
      progress("Browser Use discovered");
      const nativeTabReply = await browserUseRpc(
        automation.codexBrowserUsePipePath,
        2,
        "createTab",
        nativeSession,
      );
      const nativeTab = nativeTabReply.result as { id?: number };
      assert.equal(typeof nativeTab.id, "number");
      progress("Browser Use tab created");
      await browserUseRpc(automation.codexBrowserUsePipePath, 3, "attach", {
        ...nativeSession,
        tabId: nativeTab.id,
      });
      progress("Browser Use tab attached");
      // Codex Browser Use inspects the current document before it enables the
      // Page domain or asks CDP to navigate. A newly created isolated tab must
      // therefore have a live about:blank document before createTab returns.
      const initialDocument = await browserUseRpc(
        automation.codexBrowserUsePipePath,
        4,
        "executeCdp",
        {
          ...nativeSession,
          target: { tabId: nativeTab.id },
          method: "Runtime.evaluate",
          commandParams: {
            expression:
              "({ href: window.location.href, readyState: document.readyState })",
            returnByValue: true,
          },
        },
      );
      assert.deepEqual(
        (
          initialDocument.result as {
            result?: { value?: unknown };
          }
        ).result?.value,
        { href: "about:blank", readyState: "complete" },
      );
      await browserUseRpc(automation.codexBrowserUsePipePath, 5, "executeCdp", {
        ...nativeSession,
        target: { tabId: nativeTab.id },
        method: "Page.enable",
        commandParams: {},
      });
      await browserUseRpc(automation.codexBrowserUsePipePath, 6, "executeCdp", {
        ...nativeSession,
        target: { tabId: nativeTab.id },
        method: "Page.getFrameTree",
        commandParams: {},
      });
      progress("Browser Use blank document ready");
      await browserUseRpc(automation.codexBrowserUsePipePath, 7, "executeCdp", {
        ...nativeSession,
        target: { tabId: nativeTab.id },
        method: "Page.navigate",
        commandParams: { url: `http://127.0.0.1:${fixturePort}/` },
      });
      progress("Browser Use navigated");
      let nativeTitle = "";
      for (
        let attempt = 0;
        attempt < 100 && nativeTitle !== "Shared smoke";
        attempt += 1
      ) {
        const evaluated = await browserUseRpc(
          automation.codexBrowserUsePipePath,
          8 + attempt,
          "executeCdp",
          {
            ...nativeSession,
            target: { tabId: nativeTab.id },
            method: "Runtime.evaluate",
            commandParams: {
              expression: "document.title",
              returnByValue: true,
            },
          },
        );
        nativeTitle = String(
          (
            evaluated.result as {
              result?: { value?: unknown };
            }
          ).result?.value ?? "",
        );
        if (nativeTitle !== "Shared smoke") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(nativeTitle, "Shared smoke");
      await browserUseRpc(
        automation.codexBrowserUsePipePath,
        108,
        "moveMouse",
        {
          ...nativeSession,
          tabId: nativeTab.id,
          x: 84,
          y: 72,
        },
      );
      const pointerOverlay = await browserUseRpc(
        automation.codexBrowserUsePipePath,
        109,
        "executeCdp",
        {
          ...nativeSession,
          target: { tabId: nativeTab.id },
          method: "Runtime.evaluate",
          commandParams: {
            expression:
              "(() => { const pointer = document.querySelector('[data-zeros-agent-pointer]'); return pointer ? { label: pointer.textContent, left: pointer.style.left, top: pointer.style.top, pointerEvents: getComputedStyle(pointer).pointerEvents } : null; })()",
            returnByValue: true,
          },
        },
      );
      assert.deepEqual(
        (
          pointerOverlay.result as {
            result?: { value?: unknown };
          }
        ).result?.value,
        {
          label: "Agent",
          left: "84px",
          top: "72px",
          pointerEvents: "none",
        },
      );
      assert(
        sessionStates.some((state) => {
          const pointer = state.pointer as Record<string, unknown> | undefined;
          return pointer?.x === 84 && pointer?.y === 72;
        }),
        "native pointer activity must be published to the tab header",
      );
      const nativeScreenshot = await browserUseRpc(
        automation.codexBrowserUsePipePath,
        110,
        "executeCdp",
        {
          ...nativeSession,
          target: { tabId: nativeTab.id },
          method: "Page.captureScreenshot",
          commandParams: { format: "png" },
        },
      );
      assert(
        String((nativeScreenshot.result as { data?: string }).data ?? "")
          .length > 100,
      );
      await browserUseRpc(
        automation.codexBrowserUsePipePath,
        111,
        "executeCdp",
        {
          ...nativeSession,
          target: { tabId: nativeTab.id },
          method: "Page.close",
          commandParams: {},
        },
      );
      progress("Codex Browser Use native bridge");
      const invoke = async (
        callId: string,
        tool: string,
        args: Record<string, unknown>,
        taskId = "browser-smoke",
      ): Promise<ToolResult> => {
        const response = await fetch(automation!.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${automation!.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            threadId: `task:${taskId}`,
            turnId: "turn-smoke",
            callId,
            namespace: "zeros_browser",
            tool,
            arguments: args,
          }),
        });
        return (await response.json()) as ToolResult;
      };
      const opened = await invoke("call-open", "open", {
        url: `http://127.0.0.1:${fixturePort}/`,
      });
      progress("opened");
      assert.equal(opened.success, true);
      const initialSnapshot = JSON.parse(
        opened.contentItems?.find((item) => item.type === "inputText")?.text ??
          "{}",
      ) as {
        elements?: Array<{ ref?: string; name?: string }>;
        consoleErrors?: string[];
        networkErrors?: string[];
      };
      assert.match(
        initialSnapshot.consoleErrors?.[0] ?? "",
        /smoke console failure/,
      );
      assert.match(initialSnapshot.networkErrors?.[0] ?? "", /HTTP 503/);
      const payRef = initialSnapshot.elements?.find(
        (element) => element.name === "Pay now",
      )?.ref;
      assert(payRef, "expected Pay now to have a semantic browser ref");
      const passwordRef = initialSnapshot.elements?.find(
        (element) => element.name === "Password",
      )?.ref;
      const fileRef = initialSnapshot.elements?.find(
        (element) => element.name === "Evidence",
      )?.ref;
      const downloadRef = initialSnapshot.elements?.find(
        (element) => element.name === "Download report",
      )?.ref;
      const permissionRef = initialSnapshot.elements?.find(
        (element) => element.name === "Request notifications",
      )?.ref;
      assert(passwordRef && fileRef && downloadRef && permissionRef);

      assert.equal(
        (
          await invoke("call-cdp-disabled", "cdp", {
            method: "Runtime.evaluate",
            params: { expression: "document.title", returnByValue: true },
          })
        ).success,
        false,
      );
      automation.setDeveloperCdpEnabled(true);
      confirmation = null;
      const cdpPending = invoke("call-cdp", "cdp", {
        method: "Runtime.evaluate",
        params: { expression: "document.title", returnByValue: true },
      });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(confirmation?.category, "developer-cdp");
      assert.equal(
        automation.respondToConfirmation(confirmation!.id, "allow-once"),
        true,
      );
      assert.match(JSON.stringify(await cdpPending), /Shared smoke/);
      automation.setDeveloperCdpEnabled(false);
      confirmation = null;
      progress("developer CDP");

      target = new BrowserWindow({ show: false, width: 800, height: 600 });
      const attached = automation.attach("browser-smoke", target, {
        x: 10,
        y: 20,
        width: 640,
        height: 480,
      });
      assert(attached);
      assert.equal(attached.title, "Shared smoke");
      assert.equal(attached.taskId, "browser-smoke");

      const clickPending = invoke("call-click", "click", { ref: payRef });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(confirmation, "expected consequential click confirmation");
      assert(states.includes("awaiting-confirmation:browser-smoke"));
      assert.equal(
        automation.respondToConfirmation(confirmation.id, "allow-once"),
        true,
      );
      const clicked = await clickPending;
      assert.equal(clicked.success, true);
      const clickedSnapshot = JSON.parse(
        clicked.contentItems?.find((item) => item.type === "inputText")?.text ??
          "{}",
      ) as { text?: string };
      assert.match(clickedSnapshot.text ?? "", /Payment complete/);

      /* A user can grant a site/category policy and revoke it while the same
       * task is alive. The exact decision flow has unit coverage; this native
       * smoke verifies the live handle is wired to that broker. */
      confirmation = null;
      const secondClickPending = invoke("call-click-2", "click", {
        ref: payRef,
      });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(confirmation, "expected a second confirmation after allow-once");
      assert.equal(
        automation.respondToConfirmation(confirmation.id, "allow-site"),
        true,
      );
      assert.equal((await secondClickPending).success, true);
      assert.equal(automation.clearSiteApprovals("browser-smoke"), 1);

      confirmation = null;
      const thirdClickPending = invoke("call-click-3", "click", {
        ref: payRef,
      });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(confirmation, "expected confirmation after live policy reset");
      assert.equal(
        automation.respondToConfirmation(confirmation.id, "deny"),
        true,
      );
      assert.equal((await thirdClickPending).success, false);
      progress("click confirmations");

      confirmation = null;
      const passwordPending = invoke("call-password", "type", {
        ref: passwordRef,
        text: "smoke-secret",
      });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(confirmation?.category, "authentication");
      assert.equal(
        automation.respondToConfirmation(confirmation!.id, "allow-once"),
        true,
      );
      const passwordResult = await passwordPending;
      assert.equal(passwordResult.success, true);
      assert.doesNotMatch(JSON.stringify(passwordResult), /smoke-secret/);
      progress("password");

      const uploadPath = join(artifactRoot, "upload-evidence.txt");
      await writeFile(uploadPath, "upload evidence", { mode: 0o600 });
      confirmation = null;
      const uploadPending = invoke("call-upload", "upload", {
        ref: fileRef,
        path: uploadPath,
      });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(confirmation?.category, "file-upload");
      assert.equal(
        automation.respondToConfirmation(confirmation!.id, "allow-once"),
        true,
      );
      const uploaded = await uploadPending;
      assert.equal(uploaded.success, true);
      assert.match(JSON.stringify(uploaded), /upload-evidence\.txt/);
      progress("upload");

      confirmation = null;
      const downloadPending = invoke("call-download", "click", {
        ref: downloadRef,
      });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(confirmation?.category, "download");
      assert.equal(
        automation.respondToConfirmation(confirmation!.id, "allow-once"),
        true,
      );
      const downloaded = await downloadPending;
      assert.equal(downloaded.success, true);
      const downloadSnapshot = JSON.parse(
        downloaded.contentItems?.find((item) => item.type === "inputText")
          ?.text ?? "{}",
      ) as { downloads?: Array<{ path?: string; size?: number }> };
      assert(downloadSnapshot.downloads?.[0]?.path);
      const downloadBytes = await readFile(downloadSnapshot.downloads[0].path!);
      assert.equal(downloadBytes.length, downloadSnapshot.downloads[0].size);
      progress("download");

      confirmation = null;
      const permissionPending = invoke("call-permission", "click", {
        ref: permissionRef,
      });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(confirmation?.category, "browser-permission");
      assert.equal(
        automation.respondToConfirmation(confirmation!.id, "allow-once"),
        true,
      );
      const permissionResult = await permissionPending;
      assert.equal(permissionResult.success, true);
      assert.match(JSON.stringify(permissionResult), /permission:granted/);
      progress("permission");

      const screenshot = await invoke("call-screenshot", "screenshot", {
        annotations: [{ ref: payRef, label: "Payment CTA" }],
      });
      assert.equal(
        screenshot.success,
        true,
        `screenshot failed: ${JSON.stringify(screenshot)}`,
      );
      const screenshotMetadata = JSON.parse(
        screenshot.contentItems?.find((item) => item.type === "inputText")
          ?.text ?? "{}",
      ) as {
        artifact?: { path?: string; size?: number };
        annotations?: number;
      };
      assert(screenshotMetadata.artifact?.path);
      assert.equal(screenshotMetadata.annotations, 1);
      const artifactBytes = await readFile(screenshotMetadata.artifact.path);
      assert.equal(artifactBytes.length, screenshotMetadata.artifact.size);
      assert(artifactBytes.length > 100);
      progress("screenshot");

      const trace = await invoke("call-trace", "trace", {});
      assert.equal(trace.success, true);
      const traceMetadata = JSON.parse(
        trace.contentItems?.find((item) => item.type === "inputText")?.text ??
          "{}",
      ) as { artifact?: { path?: string; eventCount?: number } };
      assert(traceMetadata.artifact?.path);
      assert((traceMetadata.artifact.eventCount ?? 0) > 5);
      const traceBody = await readFile(traceMetadata.artifact.path, "utf8");
      assert.match(traceBody, /"confirmation"/);
      assert.match(traceBody, /"network"/);
      progress("trace");

      const snapshot = await automation.control("browser-smoke", "reload");
      assert.equal(snapshot.success, true, "attached browser reload failed");
      assert.equal(
        automation.detach("browser-smoke"),
        true,
        "attached browser detach failed",
      );
      const writer = await invoke("call-isolation-writer", "open", {
        url: `http://127.0.0.1:${fixturePort}/?isolation=writer`,
      });
      assert.match(JSON.stringify(writer), /browser-smoke-cookie=task-one/);
      const reader = await invoke(
        "call-isolation-reader",
        "open",
        { url: `http://127.0.0.1:${fixturePort}/?isolation=reader` },
        "browser-smoke-2",
      );
      assert.doesNotMatch(
        JSON.stringify(reader),
        /browser-smoke-cookie=task-one/,
        "isolated browser cookies leaked between Codex tasks",
      );
      assert.equal(
        (await invoke("call-isolation-close", "close", {}, "browser-smoke-2"))
          .success,
        true,
      );
      progress("task profile isolation");
      automation.setDeveloperCdpEnabled(true);
      confirmation = null;
      const stateCountBeforeCrash = states.length;
      const crashPending = invoke("call-renderer-crash", "cdp", {
        method: "Page.crash",
        params: {},
      });
      for (let attempt = 0; attempt < 100 && !confirmation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(confirmation?.category, "developer-cdp");
      assert.equal(
        automation.respondToConfirmation(confirmation!.id, "allow-once"),
        true,
      );
      await crashPending;
      for (
        let attempt = 0;
        attempt < 100 &&
        !states.slice(stateCountBeforeCrash).includes("closed:browser-smoke");
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(
        states.slice(stateCountBeforeCrash).includes("closed:browser-smoke"),
        "renderer crashes must close the poisoned task lease",
      );
      const recovered = await invoke("call-open-recovered", "open", {
        url: `http://127.0.0.1:${fixturePort}/`,
      });
      assert.equal(
        recovered.success,
        true,
        "browser did not recover after renderer crash",
      );
      progress("renderer crash recovery");
      const stateCountBeforeProviderSwitch = states.length;
      await automation.setProvider({ provider: "system-computer-use" });
      assert(
        states
          .slice(stateCountBeforeProviderSwitch)
          .includes("closed:browser-smoke"),
        "provider switching must close the old native task binding",
      );
      assert.equal(
        (await invoke("call-system-close", "close", {}, "system-close-task"))
          .success,
        true,
        "close must remain available under System Computer Use",
      );
      const userBrowserUrl = `http://127.0.0.1:${fixturePort}/?ordinary-browser=1`;
      const userBrowser = await automation.control(
        "user-browser:ordinary-smoke-tab",
        "open",
        { url: userBrowserUrl },
      );
      assert.equal(
        userBrowser.success,
        true,
        "ordinary in-app Browser tabs must stay native when the agent provider changes",
      );
      const userBrowserAttached = automation.attach(
        "user-browser:ordinary-smoke-tab",
        target,
        { x: 10, y: 20, width: 640, height: 480 },
      );
      assert.equal(userBrowserAttached?.title, "Shared smoke");
      assert.equal(
        (await automation.control("user-browser:ordinary-smoke-tab", "close"))
          .success,
        true,
      );
      await automation.setProvider({ provider: "isolated" });
      const handedOff = await invoke("call-provider-handoff", "snapshot", {});
      assert.equal(
        handedOff.success,
        true,
        "the existing task URL was not restored after a live provider switch",
      );
      assert(states.includes("working:browser-smoke"));
      assert(states.includes("ready:browser-smoke"));
      progress("complete");
      await new Promise<void>((resolve) =>
        process.stdout.write(
          "browser-surface-smoke: shared WebContents, confirmations, files, permissions, screenshots, and trace passed\n",
          () => resolve(),
        ),
      );
    } finally {
      target?.destroy();
      await automation?.stop();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(artifactRoot, { recursive: true, force: true });
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
