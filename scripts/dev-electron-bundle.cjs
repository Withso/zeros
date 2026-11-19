// macOS Dock, Cmd-Tab and menu labels come from the bundle; app.setName() alone
// cannot brand them, so each development instance clones a distinct bundle.

const fs = require("node:fs");
const { localInstanceBundlePaths } = require("../apps/desktop/src/engine/db/local-development-paths.cjs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEV_ICON_SRC = path.join(REPO_ROOT, "build/icons/icon-dev.icns");

/** Rename a new inode over the target: in-place writes would mutate the
 * shared base through the clone's hardlinks. */
function atomicWrite(file, data) {
  const tmp = `${file}.zeros-tmp.${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function findBaseElectronApp() {
  const candidates = [
    path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app"),
  ];
  const pnpmRoot = path.join(REPO_ROOT, "node_modules/.pnpm");
  if (fs.existsSync(pnpmRoot)) {
    for (const entry of fs.readdirSync(pnpmRoot)) {
      if (entry.startsWith("electron@")) {
        candidates.push(
          path.join(pnpmRoot, entry, "node_modules/electron/dist/Electron.app"),
        );
      }
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function readPlistValue(plist, key) {
  const m = plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
  );
  return m ? m[1] : null;
}

/** Dev bundles must declare their scheme before LaunchServices can make them
 * the OAuth callback handler. Replace the whole nested array so a cloned or
 * previously patched bundle cannot also claim Alpha or stable links. */
function patchDevProtocol(plist, local = false) {
  const declaration = local ? "<key>CFBundleURLTypes</key><array/>" : `<key>CFBundleURLTypes</key>
\t<array><dict>
\t\t<key>CFBundleURLName</key><string>Zeros Dev</string>
\t\t<key>CFBundleURLSchemes</key><array><string>zeros-dev</string></array>
\t</dict></array>`;
  const key = /<key>CFBundleURLTypes<\/key>/g.exec(plist);
  if (!key) {
    if (!/<\/dict>\s*<\/plist>\s*$/.test(plist)) {
      throw new Error("Dev bundle plist has no root dictionary");
    }
    return plist.replace(/(<\/dict>\s*<\/plist>\s*)$/, `\t${declaration}\n$1`);
  }
  const after = plist.slice(key.index + key[0].length);
  if (!/^\s*<array\s*\/?>/.test(after)) {
    throw new Error("Dev bundle callback declaration is not an array");
  }
  let depth = 0;
  for (const token of after.matchAll(/<!--[\s\S]*?-->|<(\/?)array\s*(\/?)>/g)) {
    if (token[0].startsWith("<!--")) continue;
    if (!token[2]) depth += token[1] ? -1 : 1;
    if (depth === 0) {
      const end = key.index + key[0].length + token.index + token[0].length;
      return plist.slice(0, key.index) + declaration + plist.slice(end);
    }
  }
  throw new Error("Dev bundle callback declaration is incomplete");
}

function patchPlist(plistPath, { name, exec, bundleId, local = false }) {
  let plist = fs.readFileSync(plistPath, "utf8");
  let changed = false;
  const targets = {
    CFBundleName: name,
    CFBundleDisplayName: name,
    // The Cmd-Tab / App Switcher shows CFBundleExecutable for unsigned apps
    // (which dev Electron is), so it must carry the branding too.
    CFBundleExecutable: exec,
    CFBundleIdentifier: bundleId,
    NSAppleEventsUsageDescription:
      "Zeros needs permission to interact with other apps for computer and browser tasks you request.",
  };
  for (const [key, value] of Object.entries(targets)) {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
    const m = plist.match(re);
    if (m) {
      if (m[2] !== value) {
        plist = plist.replace(re, `$1${value}$3`);
        changed = true;
      }
    } else if (
      key === "CFBundleDisplayName" ||
      key === "NSAppleEventsUsageDescription"
    ) {
      // Electron's stock plist can omit either key. Dev builds need the same
      // Automation consent explanation as packaged builds. This metadata does
      // not change the responsible app when a launcher owns the TCC request.
      plist = plist.replace(
        /(<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>)/,
        `$1\n\t<key>${key}</key>\n\t<string>${value}</string>`,
      );
      changed = true;
    }
  }
  const withProtocol = patchDevProtocol(plist, local);
  changed ||= withProtocol !== plist;
  plist = withProtocol;
  if (changed) atomicWrite(plistPath, plist);
  return changed;
}

/** CFBundleExecutable must match the on-disk name or macOS will refuse to launch. */
function patchExecutable(appDir, currentExec, targetExec) {
  const macosDir = path.join(appDir, "Contents/MacOS");
  const target = path.join(macosDir, targetExec);
  if (fs.existsSync(target)) return false; // already renamed
  for (const candidate of [currentExec, "Electron"]) {
    if (!candidate || candidate === targetExec) continue;
    const src = path.join(macosDir, candidate);
    if (fs.existsSync(src)) {
      fs.renameSync(src, target);
      return true;
    }
  }
  return false;
}

/** Keep the electron.icns filename so CFBundleIconFile still resolves. */
function patchIcon(appDir) {
  if (!fs.existsSync(DEV_ICON_SRC)) return false;
  const dest = path.join(appDir, "Contents/Resources/electron.icns");
  if (!fs.existsSync(dest)) return false;
  const srcBuf = fs.readFileSync(DEV_ICON_SRC);
  const dstBuf = fs.readFileSync(dest);
  if (srcBuf.equals(dstBuf)) return false;
  atomicWrite(dest, srcBuf);
  return true;
}

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/" +
  "Frameworks/LaunchServices.framework/Support/lsregister";

/** LaunchServices caches a bundle's name, icon and URL schemes per path; a
 * callback scheme only routes to a clone once it is registered. Best-effort. */
function refreshLaunchServices(appDir) {
  try {
    execFileSync(LSREGISTER, ["-f", appDir], { stdio: "ignore" });
  } catch {
    /* best-effort */
  }
}

/** Clone an .app bundle by HARDLINKING every file instead of copying its ~200 MB
 *  of bytes. The result is byte-identical to a copy as far as macOS is concerned
 *  (every file present, symlinks preserved, @executable_path resolves the same),
 *  but costs ~0 extra disk and is near-instant — so the copy's ENOSPC/slow-first-
 *  launch failure modes essentially disappear. Patches (Info.plist, icon, the
 *  renamed executable) never mutate the shared inodes: Info.plist/icon go through
 *  atomicWrite (rename = new inode), and the executable is only RENAMED (a
 *  dest-local dir-entry move). Hardlinks require the same filesystem (node_modules
 *  and ~/.zeros are both under $HOME); anything that can't be hardlinked
 *  (cross-device, perms) falls back to a plain byte copy for that one file. */
function cloneBundleHardlink(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      cloneBundleHardlink(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  try {
    fs.linkSync(src, dest); // hardlink — 0 bytes, shares the inode
  } catch {
    fs.copyFileSync(src, dest); // EXDEV / EPERM → fall back to a real copy
  }
}

/** Electron's version invalidates clones after a dependency upgrade. */
function readElectronVersion(appDir) {
  try {
    return fs.readFileSync(path.join(appDir, "..", "version"), "utf8").trim();
  } catch {
    return "";
  }
}

/** The Electron version a fresh clone would carry, or null off macOS. */
function currentElectronVersion() {
  const base = findBaseElectronApp();
  return base ? readElectronVersion(base) || null : null;
}

module.exports = {
  findBaseElectronApp,
  currentElectronVersion,
  patchPlist,
  prepareLocalInstanceBundle,
  localInstanceBundlePaths,
};

/** Clone the base without mutating it. Account-free Local declares no URL
 * schemes, keeping it out of hosted OAuth routing; hosted electron:alpha
 * declares the Dev callback scheme. */
function prepareLocalInstanceBundle({ slug, name, callbackScheme = false, paths = localInstanceBundlePaths({slug,name}) }) {
  if (process.platform !== "darwin") return { ok: false, binPath: null };
  const base = findBaseElectronApp();
  if (!base) return { ok: false, binPath: null };
  const dest = paths.bundlePath;
  const marker = paths.versionMarker;
  try { fs.rmSync(paths.legacyBundleRoot, { recursive: true, force: true }); }
  catch { /* Previous Local bundles were only a cache. */ }
  const version = readElectronVersion(base);
  let cached = "";
  try {
    cached = fs.readFileSync(marker, "utf8").trim();
  } catch { /* first launch */ }
  if (!version || cached !== version || !fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    cloneBundleHardlink(base, dest);
    if (version) fs.writeFileSync(marker, version);
  }
  const plistPath = path.join(dest, "Contents", "Info.plist");
  const current =
    readPlistValue(fs.readFileSync(plistPath, "utf8"), "CFBundleExecutable") || "Electron";
  patchExecutable(dest, current, name);
  patchPlist(plistPath, {
    name, exec: name, bundleId: `com.zeros.local.${slug}`, local: !callbackScheme,
  });
  patchIcon(dest);
  if (callbackScheme) refreshLaunchServices(dest);
  return { ok: true, binPath: path.join(dest, "Contents", "MacOS", name) };
}
