// Loaded into the native check's Electron main process only (electron -r). It changes four things, each
// recorded for the report:
// - the login shell is the run's stub: main's PATH hydration (fix-path → default-shell) asks os.userInfo() for the
//   account's shell before $SHELL, and the person's real shell would load system profiles (and their PATH, with its gh);
// - no OS-level registration: setAsDefaultProtocolClient would write this Mac's LaunchServices (zeros-dev://);
// - no spellcheck dictionary download from Google (Linux only; macOS uses the system spellchecker);
// - a fixture session: every auth_* command answers a synthetic fixture user, so nothing reads or writes the
//   keychain, WorkOS or the person's signed-in session. Every other command reaches the app's own handler.
"use strict";
if (process.versions.electron && process.type === "browser" && process.env.ZEROS_NATIVE_CHECK_USER) {
  const electron = require("electron");
  const fs = require("node:fs");
  const log = process.env.ZEROS_NATIVE_CHECK_HOOK_LOG;
  const record = (entry) => { if (log) try { fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`); } catch { /* best effort */ } };
  const os = require("node:os"), userInfo = os.userInfo, stub = process.env.SHELL;
  if (stub) {
    os.userInfo = (...args) => ({ ...userInfo(...args), shell: stub });
    // ESM importers (default-shell) read the builtin's named exports, which only follow after a sync.
    require("node:module").syncBuiltinESMExports();
    record({ kind: "user-shell-redirected" });
  }
  electron.app.setAsDefaultProtocolClient = (scheme) => { record({ kind: "protocol-client-refused", scheme }); return false; };
  electron.app.removeAsDefaultProtocolClient = () => false;
  if (process.platform !== "darwin") electron.app.on("session-created", (session) => {
    session.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/");
    record({ kind: "spellcheck-download-disabled" });
  });
  const user = JSON.parse(process.env.ZEROS_NATIVE_CHECK_USER);
  const account = { accountId: user.accountId, email: user.email, name: user.name, provider: "workos", active: true };
  const answers = {
    auth_get_access_token: { access_token: "synthetic-native-check", account: user.accountId },
    auth_get_session_user: user,
    auth_list_accounts: { accounts: [account] },
    auth_security_revalidate: null,
    auth_cancel_signin: null,
  };
  const handle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, listener) => {
    if (channel !== "zeros:invoke") return handle(channel, listener);
    record({ kind: "invoke-wrapped" });
    return handle(channel, async (event, payload) => {
      const cmd = payload && typeof payload === "object" ? payload.cmd : undefined;
      if (typeof cmd === "string" && cmd.startsWith("auth_")) {
        record({ kind: "auth", cmd });
        if (cmd in answers) return answers[cmd];
        throw new Error(`The native check has no fixture answer for ${cmd}.`);
      }
      return listener(event, payload);
    });
  };
}
