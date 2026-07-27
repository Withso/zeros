// ──────────────────────────────────────────────────────────
// Dev vs packaged detection
// ──────────────────────────────────────────────────────────
//
// Electron 33's `app.isPackaged` is implemented by checking the
// basename of `process.execPath` — if it equals "Electron" it's
// considered dev, otherwise packaged. Our dev launcher renames the
// on-disk binary to "Zeros Dev" for Dock/App-Switcher branding
// (scripts/rename-electron-dev-binary.cjs), which makes
// `app.isPackaged` return `true` even when running `pnpm
// electron:dev`. Symptoms: sidecar tries to spawn the prod binary
// and fails ("engine binary not found"), the auto-updater fires,
// the userData path doesn't get scoped to "Zeros Dev".
//
// `process.defaultApp` is set to `true` by Electron's CLI when it
// launches via `electron .` / `electron <script>`. It survives
// arbitrary executable renames and is the reliable dev detector.
// Use IS_PACKAGED everywhere instead of `app.isPackaged`.
//
// We can't simply not rename the executable — CFBundleExecutable
// in Info.plist must match the on-disk binary name, and the
// rename also updates the Cmd-Tab / Activity Monitor process name
// to "Zeros Dev" which is the whole point.

interface ProcessWithDefaultApp {
  defaultApp?: boolean;
}

export const IS_PACKAGED: boolean =
  !(process as NodeJS.Process & ProcessWithDefaultApp).defaultApp;

export const IS_DEV: boolean = !IS_PACKAGED;
