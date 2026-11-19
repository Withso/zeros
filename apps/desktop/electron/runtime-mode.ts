// ──────────────────────────────────────────────────────────
// Dev vs packaged detection
// ──────────────────────────────────────────────────────────
//
// `app.isPackaged` derives its result from the executable identity, and the
// development launchers rename the cloned Electron executable for Dock and
// App Switcher branding (scripts/dev-electron-bundle.cjs). A renamed unpackaged
// binary therefore reports `app.isPackaged === true`: the sidecar would look for
// the packaged engine binary and the auto-updater would start.
//
// `process.defaultApp` is set to `true` by Electron's CLI when it launches via
// `electron .` / `electron <script>`. It survives arbitrary executable renames
// and is the reliable dev detector. Use IS_PACKAGED everywhere instead of
// `app.isPackaged`.

interface ProcessWithDefaultApp {
  defaultApp?: boolean;
}

export const IS_PACKAGED: boolean =
  !(process as NodeJS.Process & ProcessWithDefaultApp).defaultApp;

export const IS_DEV: boolean = !IS_PACKAGED;

declare const __ZEROS_LOCAL_DEVELOPMENT_BUILD__: boolean | undefined;
declare const __ZEROS_CHANNEL_BAKED__: string | undefined;

const bakedLocalBuild =
  typeof __ZEROS_LOCAL_DEVELOPMENT_BUILD__ !== "undefined" &&
  __ZEROS_LOCAL_DEVELOPMENT_BUILD__ === true;
const bakedChannel =
  typeof __ZEROS_CHANNEL_BAKED__ === "string" ? __ZEROS_CHANNEL_BAKED__ : "";
const requested =
  IS_DEV &&
  process.env.ZEROS_LOCAL_DEVELOPMENT === "1" &&
  process.env.ZEROS_CHANNEL === "dev" &&
  (bakedChannel === "" || bakedChannel === "dev");

/** Only the explicit native, unpackaged development launch may skip login.
 * Release channels and packaged executables ignore the request entirely. */
export const IS_LOCAL_DEVELOPMENT: boolean =
  requested && bakedLocalBuild;

export const LOCAL_DEVELOPMENT_BUILD_ERROR: string | null =
  IS_DEV && requested !== bakedLocalBuild
    ? `[Zeros] This checkout's dist-electron was built by ${bakedLocalBuild ? "pnpm electron:local" : "pnpm electron:alpha"}; both cannot run from one checkout at once — stop the other launcher and relaunch.`
    : null;
