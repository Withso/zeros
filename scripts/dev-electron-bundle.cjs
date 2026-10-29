// macOS Dock, Cmd-Tab and menu labels come from the bundle; app.setName() alone
// cannot brand them. Linked worktrees clone a distinct bundle identity.
// Bundle preparation is best-effort: launcher environment still isolates data
// and ports if it falls back to the shared bundle.

const fs = require("node:fs");
const { localInstanceBundlePaths } = require("../apps/desktop/src/engine/db/local-development-paths.cjs");
const os = require("node:os");
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

const SHARED_DEV = {
  name: "Zeros Dev",
  exec: "Zeros Dev",
  bundleId: "com.zeros.dev",
};

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
 * previously patched bundle cannot also claim Alpha, Beta or stable links. */
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

/** Only the shared bundle needs path.txt: instance bundles launch by absolute path. */
function patchPathTxt(electronPkgDir, targetExec) {
  const pathTxt = path.join(electronPkgDir, "path.txt");
  const want = `Electron.app/Contents/MacOS/${targetExec}`;
  let current;
  try {
    current = fs.readFileSync(pathTxt, "utf8").trim();
  } catch {
    return false; // no path.txt here
  }
  if (current === want) return false;
  fs.writeFileSync(pathTxt, want);
  return true;
}

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/" +
  "Frameworks/LaunchServices.framework/Support/lsregister";

function refreshLaunchServices(appDir) {
  // LaunchServices caches CFBundleName/icon per bundle path; force a re-register
  // so the Dock/Cmd-Tab pick up the patched metadata. Best-effort.
  try {
    execFileSync(LSREGISTER, ["-f", appDir], { stdio: "ignore" });
  } catch {
    /* best-effort */
  }
}

/** Unregister before deleting: stale bundles share the instance ID and can
 * keep serving old labels/icons. Cleanup must never block launch. */
function discardBundle(appDir) {
  try {
    fs.lstatSync(appDir);
  } catch {
    return; // nothing there — skip the subprocess
  }
  try {
    execFileSync(LSREGISTER, ["-u", appDir], { stdio: "ignore" });
  } catch {
    /* best-effort (also the non-darwin path — no lsregister to run) */
  }
  try {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(`${appDir}.version`, { force: true });
  } catch {
    /* best-effort */
  }
}

function patchBundleIdentity(appDir, { name, exec, bundleId, withPathTxt }) {
  const plistPath = path.join(appDir, "Contents/Info.plist");
  if (!fs.existsSync(plistPath)) {
    console.warn(`[dev-electron-bundle] missing ${plistPath} — skipping`);
    return { ok: false, binPath: null };
  }
  const plist = fs.readFileSync(plistPath, "utf8");
  const currentExec = readPlistValue(plist, "CFBundleExecutable") || "Electron";
  // Order matters: rename the on-disk binary first, then patch the plist
  // (CFBundleExecutable must match the new file).
  const execChanged = patchExecutable(appDir, currentExec, exec);
  const plistChanged = patchPlist(plistPath, { name, exec, bundleId });
  const iconChanged = patchIcon(appDir);
  const pathTxtChanged = withPathTxt
    ? patchPathTxt(path.resolve(appDir, "../.."), exec)
    : false;
  // Refresh even unchanged bundles: macOS caches the launch-bounce icon by
  // path, independently of the running app's Dock icon.
  try {
    fs.utimesSync(appDir, new Date(), new Date());
  } catch {
    /* best-effort */
  }
  refreshLaunchServices(appDir);
  if (plistChanged || execChanged || iconChanged || pathTxtChanged) {
    const bits = [
      plistChanged && `name → "${name}"`,
      execChanged && `executable → "${exec}"`,
      pathTxtChanged && "path.txt",
      iconChanged && "icon → icon-dev.icns",
    ].filter(Boolean);
    console.log(`[dev-electron-bundle] patched ${bits.join(", ")}`);
  }
  return { ok: true, binPath: path.join(appDir, "Contents/MacOS", exec) };
}

function prepareSharedDevBundle() {
  if (process.platform !== "darwin") return { ok: false, binPath: null };
  const appDir = findBaseElectronApp();
  if (!appDir) {
    console.warn("[dev-electron-bundle] Electron.app not found — skipping");
    return { ok: false, binPath: null };
  }
  return patchBundleIdentity(appDir, { ...SHARED_DEV, withPathTxt: true });
}

/** The Dock reads the bundle filename; Cmd-Tab reads process metadata. Keep
 * the display name in the filename and uniqueness in its parent slug.
 * Dev clones belong under ~/.zeros-dev, never the production ~/.zeros. */
function instanceBundleDir(slug, name) {
  return path.join(instancesRoot(), slug, `${name}.app`);
}

function instancesRoot() {
  return path.join(os.homedir(), ".zeros-dev", "dev-instances");
}

/** Remove the legacy flat bundle: it shares the replacement's bundle ID
 * and can leave LaunchServices serving the old Dock name. */
function legacyInstanceBundleDir(slug) {
  return path.join(instancesRoot(), `${slug}.app`);
}

/** A display-name change can keep the same slug; remove siblings so only
 * one bundle claims that instance ID. */
function pruneStaleBundles(dir, keep) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // first launch — the directory isn't there yet
  }
  for (const entry of entries) {
    if (entry === keep || !entry.endsWith(".app")) continue;
    discardBundle(path.join(dir, entry));
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

function prepareInstanceBundle({ slug, name }) {
  if (process.platform !== "darwin") return { ok: false, binPath: null };
  const base = findBaseElectronApp();
  if (!base) {
    console.warn(
      "[dev-electron-bundle] base Electron.app not found — instance uses shared bundle",
    );
    return { ok: false, binPath: null };
  }
  const dest = instanceBundleDir(slug, name);
  const versionMarker = `${dest}.version`;
  const baseVersion = readElectronVersion(base);
  // Retire stale identities even on a cache hit; otherwise old names survive indefinitely.
  discardBundle(legacyInstanceBundleDir(slug));
  pruneStaleBundles(path.dirname(dest), path.basename(dest));
  let cachedVersion = "";
  try {
    cachedVersion = fs.readFileSync(versionMarker, "utf8").trim();
  } catch {
    /* no marker yet */
  }
  const cacheValid =
    !!baseVersion && cachedVersion === baseVersion && fs.existsSync(dest);
  try {
    if (!cacheValid) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      console.log(
        `[dev-electron-bundle] hardlink-cloning Electron.app → ${dest} (first launch of "${name}"; ~0 disk)`,
      );
      cloneBundleHardlink(base, dest);
      if (baseVersion) fs.writeFileSync(versionMarker, baseVersion);
    }
  } catch (err) {
    console.warn(
      `[dev-electron-bundle] instance bundle copy failed (${
        err && err.message ? err.message : err
      }) — falling back to shared bundle`,
    );
    return { ok: false, binPath: null };
  }
  return patchBundleIdentity(dest, {
    name,
    exec: name,
    bundleId: `com.zeros.dev.${slug}`,
    withPathTxt: false,
  });
}

module.exports = {
  findBaseElectronApp,
  prepareSharedDevBundle,
  prepareInstanceBundle,
  instanceBundleDir,
  legacyInstanceBundleDir,
  pruneStaleBundles,
  discardBundle,
  patchPlist,
  prepareLocalInstanceBundle,
  localInstanceBundlePaths,
};

/** Local clones the base without branding/mutating hosted Dev's shared bundle.
 * A separate cache and no URL schemes keep it out of hosted OAuth routing. */
function prepareLocalInstanceBundle({ slug, name, paths = localInstanceBundlePaths({slug,name}) }) {
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
    name, exec: name, bundleId: `com.zeros.local.${slug}`, local: true,
  });
  patchIcon(dest);
  return { ok: true, binPath: path.join(dest, "Contents", "MacOS", name) };
}
