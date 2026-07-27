// ──────────────────────────────────────────────────────────
// Dev Electron.app identity helpers (macOS)
// ──────────────────────────────────────────────────────────
//
// `pnpm electron:dev` launches the prebuilt Electron binary shipped in
// node_modules, whose Info.plist says CFBundleName = "Electron" — what macOS
// shows in the Dock tooltip, Apple menu, Cmd-Tab switcher, and About dialog.
// `app.setName()` from JS renames app.getName()/userData but does NOT override
// those macOS-level labels; only patching the bundle does.
//
// Two callers, both routed through scripts/dev-instance.mjs:
//
//   • prepareSharedDevBundle()  — the PRIMARY dev checkout. Patches the shared
//     node_modules Electron.app IN PLACE → "Zeros Dev" / design.zeros.app.dev,
//     exactly the historical scripts/rename-electron-dev-binary.cjs behavior.
//
//   • prepareInstanceBundle()   — a per-worktree dev instance. HARDLINK-clones the
//     base Electron.app to ~/.zeros-dev/dev-instances/<slug>.app and patches it →
//     "zeros-<name>" with a DISTINCT bundle id (com.zeros.dev.<slug>), so
//     LaunchServices treats it as its own app (own Dock slot + Cmd-Tab entry, its
//     own name). Every dev instance shares the one Zeros dev icon; the NAME is
//     what tells them apart. Cached by the base Electron version; re-patch
//     (name/id) is cheap on subsequent launches.
//
// All operations are darwin-only, idempotent, and best-effort: any failure
// returns { ok: false } so the launcher falls back to the shared bundle — the
// instance still runs fully isolated (data/ports come from env vars), just
// without the distinct Dock identity.
// ──────────────────────────────────────────────────────────

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEV_ICON_SRC = path.join(REPO_ROOT, "build/icons/icon-dev.icns");

/** Write atomically: temp file + rename over the target. Crucial for the
 *  hardlink clone below — a plain writeFileSync would truncate-in-place and thus
 *  mutate the SHARED base inode; rename swaps the directory entry for a NEW inode,
 *  leaving the base bundle untouched. Also makes every patch crash-safe. */
function atomicWrite(file, data) {
  const tmp = `${file}.zeros-tmp.${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Identity for the primary dev checkout — unchanged from the legacy rename script.
const SHARED_DEV = {
  name: "Zeros Dev",
  exec: "Zeros Dev",
  bundleId: "com.zeros.dev",
};

/** Locate the prebuilt Electron.app in node_modules (pnpm hoists it under
 *  .pnpm/electron@<version>/…). Returns the .app path or null. */
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

function patchPlist(plistPath, { name, exec, bundleId }) {
  let plist = fs.readFileSync(plistPath, "utf8");
  let changed = false;
  const targets = {
    CFBundleName: name,
    CFBundleDisplayName: name,
    // The Cmd-Tab / App Switcher shows CFBundleExecutable for unsigned apps
    // (which dev Electron is), so it must carry the branding too.
    CFBundleExecutable: exec,
    CFBundleIdentifier: bundleId,
  };
  for (const [key, value] of Object.entries(targets)) {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
    const m = plist.match(re);
    if (m) {
      if (m[2] !== value) {
        plist = plist.replace(re, `$1${value}$3`);
        changed = true;
      }
    } else if (key === "CFBundleDisplayName") {
      // Electron's stock plist sometimes omits the display-name key.
      plist = plist.replace(
        /(<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>)/,
        `$1\n\t<key>CFBundleDisplayName</key>\n\t<string>${value}</string>`,
      );
      changed = true;
    }
  }
  if (changed) atomicWrite(plistPath, plist);
  return changed;
}

/** Rename Contents/MacOS/<current> → <target> so `ps`/Activity Monitor/App
 *  Switcher show the branding. CFBundleExecutable must match the file on disk or
 *  macOS refuses to launch. Robust to pristine ("Electron"), already-renamed
 *  (target present → skip), and partial states. */
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

/** Overwrite the bundle's electron.icns with the Zeros dev icon (filename
 *  unchanged, so the plist's CFBundleIconFile still resolves). No-op if the
 *  source icon is missing or already identical. */
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

/** The `electron` npm CLI launches whatever ../../path.txt points at. Only the
 *  shared in-place bundle needs this (a copied instance bundle is launched by
 *  its absolute binary path, so its path.txt is irrelevant). */
function patchPathTxt(electronPkgDir, targetExec) {
  const pathTxt = path.join(electronPkgDir, "path.txt");
  const want = `Electron.app/Contents/MacOS/${targetExec}`;
  // Read directly and treat a missing file as "nothing to patch" (no existsSync
  // guard before the write) so there's no check-then-use TOCTOU window.
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

function refreshLaunchServices(appDir) {
  // LaunchServices caches CFBundleName/icon per bundle path; force a re-register
  // so the Dock/Cmd-Tab pick up the patched metadata. Best-effort.
  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/" +
    "Frameworks/LaunchServices.framework/Support/lsregister";
  try {
    execFileSync(lsregister, ["-f", appDir], { stdio: "ignore" });
  } catch {
    /* best-effort */
  }
}

/** Patch an .app bundle's identity in place. Reads the CURRENT
 *  CFBundleExecutable so it works whether the bundle is pristine or already
 *  branded. Returns { ok, binPath } where binPath is the launchable executable. */
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
  // Always bump the bundle mtime + re-register with LaunchServices, even when
  // nothing changed this launch. macOS caches the Dock launch-bounce icon per
  // bundle PATH, and that cache goes stale after the icon is swapped — so the
  // bounce shows the OLD icon, then app.dock.setIcon corrects it (a visible
  // dark→light "transform"). Re-touching + re-registering every launch forces
  // macOS to re-read the CURRENT electron.icns for the bounce too, killing the flash.
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

/** PRIMARY dev checkout: patch the shared node_modules Electron.app in place. */
function prepareSharedDevBundle() {
  if (process.platform !== "darwin") return { ok: false, binPath: null };
  const appDir = findBaseElectronApp();
  if (!appDir) {
    console.warn("[dev-electron-bundle] Electron.app not found — skipping");
    return { ok: false, binPath: null };
  }
  return patchBundleIdentity(appDir, { ...SHARED_DEV, withPathTxt: true });
}

function instanceBundleDir(slug) {
  // Under the DEV dot-dir (~/.zeros-dev), never the production ~/.zeros — these
  // are dev-only launcher clones and must not pollute the prod data dir.
  return path.join(os.homedir(), ".zeros-dev", "dev-instances", `${slug}.app`);
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

/** Electron ships a plaintext version file at dist/version, sibling of the
 *  Electron.app — used as the copy cache key so a `pnpm install` that bumps
 *  Electron re-copies the instance bundle. */
function readElectronVersion(appDir) {
  try {
    return fs.readFileSync(path.join(appDir, "..", "version"), "utf8").trim();
  } catch {
    return "";
  }
}

/** NAMED per-worktree instance: copy + patch a dedicated bundle. Returns
 *  { ok, binPath }; { ok: false } tells the launcher to fall back to shared. */
function prepareInstanceBundle({ slug, name }) {
  if (process.platform !== "darwin") return { ok: false, binPath: null };
  const base = findBaseElectronApp();
  if (!base) {
    console.warn(
      "[dev-electron-bundle] base Electron.app not found — instance uses shared bundle",
    );
    return { ok: false, binPath: null };
  }
  const dest = instanceBundleDir(slug);
  const versionMarker = `${dest}.version`;
  const baseVersion = readElectronVersion(base);
  // Read the marker directly (no existsSync guard before the later write to the
  // same marker) to avoid a check-then-use TOCTOU: a missing/unreadable marker
  // just reads as "" → treated as stale → re-clone.
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
};
