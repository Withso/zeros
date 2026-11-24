// Loaded into the Alpha check's Electron main process only (electron -r). Sign-in is the app's own; this changes:
// - the login shell is the run's stub (main's PATH hydration asks os.userInfo() for the account's shell before $SHELL);
// - no OS-level registration: setAsDefaultProtocolClient would write this Mac's LaunchServices (zeros-dev://);
// - no spellcheck dictionary download from Google (Linux only; macOS uses the system spellchecker);
// - Linux only: safeStorage keeps this isolated profile's session with an in-memory key (no OS password store);
// - no browser: shell.openExternal records the URL for the check (the sign-in page is filled in the check's own
//   headless browser, and its callback is handed back as a second instance). Nothing opens on the person's desktop.
"use strict";
if (process.versions.electron && process.type === "browser" && process.env.ZEROS_NATIVE_ALPHA_CHECK === "1") {
  const electron = require("electron");
  const fs = require("node:fs");
  const log = process.env.ZEROS_NATIVE_ALPHA_HOOK_LOG;
  const record = (entry) => { if (log) try { fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`); } catch { /* best effort */ } };
  const os = require("node:os"), userInfo = os.userInfo, stub = process.env.SHELL;
  if (stub) {
    os.userInfo = (...args) => ({ ...userInfo(...args), shell: stub });
    require("node:module").syncBuiltinESMExports();
    record({ kind: "user-shell-redirected" });
  }
  electron.app.setAsDefaultProtocolClient = (scheme) => { record({ kind: "protocol-client-refused", scheme }); return false; };
  electron.app.removeAsDefaultProtocolClient = () => false;
  // Linux (development) has no OS password store here: safeStorage then uses an in-memory key for this isolated
  // profile, as its own setUsePlainTextEncryption documents. macOS runs with --use-mock-keychain instead.
  if (process.platform === "linux") electron.app.once("ready", () => {
    electron.safeStorage.setUsePlainTextEncryption?.(true);
    record({ kind: "linux-plain-text-encryption" });
  });
  if (process.platform !== "darwin") electron.app.on("session-created", (session) => {
    session.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/");
    record({ kind: "spellcheck-download-disabled" });
  });
  // Read by the check through Playwright's app.evaluate; the URL itself is never logged (it carries the PKCE state).
  const opened = [];
  Object.defineProperty(globalThis, "__zerosAlphaCheckOpened", { value: opened, enumerable: false });
  electron.shell.openExternal = async (url) => {
    let origin = "?";
    try { origin = new URL(url).origin; } catch { /* recorded as ? */ }
    opened.push(url);
    record({ kind: "open-external-captured", origin });
  };
}
