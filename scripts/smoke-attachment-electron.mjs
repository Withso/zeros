// Native File selection and graceful quit/relaunch, using the production
// preload, attachment IPC, composer and draft persistence in an isolated app.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { _electron as electron } from "@playwright/test";

if (process.platform !== "darwin") {
  console.log("attachment-electron smoke skipped: requires macOS");
  process.exit(0);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "zeros-attachment-electron-smoke-"),
);
const workspace = path.join(root, "workspace");
const profile = path.join(root, "profile");
const privateData = path.join(root, "private");
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const url = `http://127.0.0.1:${port}/apps/desktop/src/renderer/harnesses/harness-composer-editor.html?hold-uploads`;
const vite = spawn(
  "pnpm",
  [
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: repo, stdio: "ignore", detached: true },
);
let app;
const errors = [];
try {
  await fs.mkdir(workspace);
  await fs.mkdir(profile);
  const preload = path.join(root, "preload.cjs");
  await build({
    entryPoints: [path.join(repo, "apps/desktop/electron/preload.ts")],
    outfile: preload,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  const main = path.join(root, "main.cjs");
  await build({
    stdin: {
      resolveDir: repo,
      loader: "ts",
      contents: `
    import { app, BrowserWindow, ipcMain } from "electron";
    import { registerAttachmentSourceIpc, prepareAttachmentsForQuit } from "./apps/desktop/electron/ipc/attachment-source";
    import { setMainWindow } from "./apps/desktop/electron/ipc/events";
    import { transferContextAttachment } from "./apps/desktop/src/engine/files/attachment-transfer";
    app.setPath("userData", ${JSON.stringify(profile)});
    let readyToQuit = false;
    app.on("before-quit", event => {
      if (readyToQuit) return;
      event.preventDefault();
      void prepareAttachmentsForQuit().then(() => { readyToQuit = true; app.quit(); });
    });
    app.whenReady().then(async () => {
      app.dock?.hide();
      const window = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      setMainWindow(window);
      registerAttachmentSourceIpc();
      ipcMain.handle("zeros:invoke", (event, {cmd, args}) => {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Wrong renderer");
        if (cmd === "agent_attachment_write") return transferContextAttachment(${JSON.stringify(workspace)}, args, {allowNativeSource: true});
        return {};
      });
      await window.loadURL(${JSON.stringify(url)});
    });
  `,
    },
    outfile: main,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  const deadline = Date.now() + 60_000;
  while (
    !(await fetch(url).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    assert(Date.now() < deadline, "Vite did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const launch = async () => {
    app = await electron.launch({
      args: [main],
      cwd: repo,
      env: { ...process.env, ZEROS_DATA_DIR: privateData, ZEROS_DEV: "1" },
    });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".composer-pm").waitFor();
    return page;
  };
  let page = await launch();
  const source = path.join(root, "selected.jsonl");
  const bytes = '{"text":"é"}\r\n{"n":2}\n';
  await fs.writeFile(source, bytes);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "native-selection";
    input.onchange = () => {
      window.__nativeSelectionDone = window.__composerHarness.insertFiles([
        ...input.files,
      ]);
    };
    document.body.append(input);
  });
  await page.locator("#native-selection").setInputFiles(source);
  const original = await page.evaluate(async () => {
    await window.__nativeSelectionDone;
    const api = window.__composerHarness;
    api.editor.commands.insertContent("the latest native draft");
    const snapshot = api.serialize();
    const { prepareAttachmentSource } =
      await import("/apps/desktop/src/renderer/features/agent/attachment-sources.ts");
    const prepared = await prepareAttachmentSource(snapshot.attachments[0]);
    const { schedulePersistDrafts } =
      await import("/apps/desktop/src/renderer/state/persist-composer-drafts.ts");
    schedulePersistDrafts({
      chatComposerDrafts: {
        recovery: {
          text: snapshot.displayText,
          attachments: snapshot.attachments,
          json: snapshot.json,
        },
      },
      editComposerDrafts: {},
      pendingAutoSend: {},
    });
    return {
      sourceId: prepared.nativeSourceId,
      attachmentId: snapshot.attachments[0].id,
    };
  });
  assert(
    original.sourceId,
    "A real selected file must use the native capability",
  );
  const quitStart = Date.now();
  await app.close();
  app = undefined;
  assert(
    Date.now() - quitStart < 15_000,
    "Quit waited for the held upload instead of source preparation",
  );
  page = await launch();
  const restored = await page.evaluate(async () => {
    const { loadPersistedDrafts } =
      await import("/apps/desktop/src/renderer/state/persist-composer-drafts.ts");
    const draft = loadPersistedDrafts().chats.recovery;
    if (!draft) throw new Error("The draft was not flushed on quit");
    const { setActiveBridge } =
      await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
    setActiveBridge({
      executionIdentity: { kind: "local", sidecar: "active" },
      request: async (message) => ({
        type: "WORKSPACE_RESPONSE",
        result:
          message.op === "attachment.write"
            ? await window.__ZEROS_NATIVE__.invoke(
                "agent_attachment_write",
                message.params,
              )
            : { workspaces: [] },
      }),
    });
    const api = window.__composerHarness;
    api.setContent(draft);
    const attachment = api.serialize().attachments[0];
    const { ensureFileAttachment } =
      await import("/apps/desktop/src/renderer/features/agent/file-attachment-transfer.ts");
    const saved = await ensureFileAttachment(
      "/composer-editor-harness",
      attachment,
    );
    return {
      text: api.serialize().displayText,
      sourceId: attachment.sourceRecoveryId,
      attachmentId: attachment.id,
      saved,
    };
  });
  assert(restored.text.includes("the latest native draft"));
  assert.equal(restored.sourceId, original.sourceId);
  assert.equal(restored.attachmentId, original.attachmentId);
  assert.equal(await fs.readFile(restored.saved.absolutePath, "utf8"), bytes);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      nativeSelection: true,
      gracefulQuit: true,
      draftRestored: true,
      resumedCopy: true,
      exactBytes: true,
    }),
  );
} finally {
  await app?.close();
  process.kill(-vite.pid, "SIGTERM");
  await fs.rm(root, { recursive: true, force: true });
}
