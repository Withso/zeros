// ──────────────────────────────────────────────────────────
// electron-builder afterPack hook — deep ad-hoc resign
// ──────────────────────────────────────────────────────────
//
// Without a Developer ID, electron-builder's default ad-hoc sign is
// incomplete on arm64 Macs — macOS rejects it with "code has no
// resources but signature indicates they must be present" and the
// app silently exits on launch.
//
// Running `codesign --force --deep --sign -` re-signs the app
// bundle with a COMPLETE ad-hoc signature that seals all nested
// resources + frameworks. The user still needs
//   xattr -cr /Applications/Zeros.app
// to strip the quarantine flag on first install, but once that's
// done the app launches normally.
//
// When we buy an Apple Developer cert (P4), set CSC_LINK + flip the signing
// keys in electron-builder.yml — this hook self-skips (see the CSC_LINK guard
// below) so it never clobbers the real Developer ID signature / notarization.
// ──────────────────────────────────────────────────────────

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

/** Non-stable packs reuse the base electron-builder.yml, whose mac.extendInfo
 *  declares `CFBundleURLSchemes: [zeros]`. Without this, an Alpha or Beta .app
 *  would register the SAME zeros:// scheme as Production, and macOS
 *  LaunchServices could route a Production sign-in to it — the "Open Zeros Beta?"
 *  mis-route. Rewrite the packaged Info.plist to the channel's own scheme + URL
 *  name here in afterPack, which runs BEFORE electron-builder's doSignAfterPack —
 *  so the Developer-ID signature seals this edit (a CLI `-c` override can't do it:
 *  yargs turns the numeric keypath into `{"0":…}` objects that malform the plist
 *  array). Fail LOUD if the expected entry is missing — silently shipping a
 *  non-stable channel on zeros:// would resurrect the collision this exists to fix.
 *
 *  Keep the scheme/name pairs in lockstep with src/engine/runtime.ts's
 *  schemeForChannel() + electron/main.ts's CHANNEL_DISPLAY_NAME. Stable is absent
 *  on purpose: it IS the base plist, so it needs no patch. */
const CHANNEL_PLIST = {
  alpha: { scheme: "zeros-alpha", name: "Zeros Alpha" },
  beta: { scheme: "zeros-beta", name: "Zeros Beta" },
};

function patchChannelUrlScheme(appPath, ch) {
  const target = CHANNEL_PLIST[ch];
  if (!target) {
    throw new Error(
      `[afterPack] URL-scheme patch: no plist mapping for channel "${ch}" — ` +
        `add it to CHANNEL_PLIST (keep in lockstep with schemeForChannel()).`,
    );
  }
  const plist = path.join(appPath, "Contents", "Info.plist");
  const schemeKey = ":CFBundleURLTypes:0:CFBundleURLSchemes:0";
  const nameKey = ":CFBundleURLTypes:0:CFBundleURLName";
  const print = (key) =>
    execFileSync(PLIST_BUDDY, ["-c", `Print ${key}`, plist], {
      encoding: "utf8",
    }).trim();
  const set = (key, value) =>
    execFileSync(PLIST_BUDDY, ["-c", `Set ${key} ${value}`, plist], {
      stdio: "inherit",
    });

  let current;
  try {
    current = print(schemeKey);
  } catch (err) {
    throw new Error(
      `[afterPack] ${ch} URL-scheme patch: ${schemeKey} not found in ${plist} — ` +
        `electron-builder.yml's mac.extendInfo.CFBundleURLTypes changed shape. ` +
        `Fix the keypath so ${ch} can't register the prod zeros:// scheme. ` +
        `(${err instanceof Error ? err.message : err})`,
    );
  }
  // Idempotent + guarded: only rewrite the known base scheme, never guess.
  if (current !== "zeros" && current !== target.scheme) {
    throw new Error(
      `[afterPack] ${ch} URL-scheme patch: expected base scheme "zeros" at ` +
        `${schemeKey} but found "${current}" — refusing to guess.`,
    );
  }
  set(schemeKey, target.scheme);
  set(nameKey, target.name);
  const after = print(schemeKey);
  if (after !== target.scheme) {
    throw new Error(
      `[afterPack] ${ch} URL-scheme patch: verification failed — ${schemeKey} is ` +
        `"${after}", expected "${target.scheme}".`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[afterPack] ${ch} URL scheme → ${target.scheme} (${plist})`);
}

/** @type {import("electron-builder").AfterPackContext => Promise<void>} */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // Non-stable channels: rewrite the URL scheme to the channel's own BEFORE any
  // signing below (and before electron-builder's own doSignAfterPack), so the
  // collision-free scheme is what gets sealed. Stable is skipped so its packs stay
  // byte-identical to the base config. Mirrors ZEROS_CHANNEL, which
  // scripts/electron-builder-run.mjs exports into electron-builder's env.
  const packChannel = process.env.ZEROS_CHANNEL;
  if (packChannel && packChannel !== "stable" && packChannel !== "dev") {
    patchChannelUrlScheme(appPath, packChannel);
  }

  // Signed path: when a Developer ID cert is configured, electron-builder will
  // apply a proper signature (in doSignAfterPack, after this hook) and notarize.
  // An ad-hoc re-sign here would be overwritten and could invalidate that — so
  // skip it. (The beta scheme patch above still applies: it runs before signing.)
  if (process.env.CSC_LINK) {
    // eslint-disable-next-line no-console
    console.log(
      "[afterPack] CSC_LINK set → skipping ad-hoc re-sign (Developer ID signing in effect)",
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[afterPack] deep ad-hoc re-sign: ${appPath}`);
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "inherit",
    });
  } catch (err) {
    // Surface the codesign failure — silent failure here means the
    // packaged app will mysteriously exit on launch with no log.
    throw new Error(
      `afterPack codesign failed: ${err instanceof Error ? err.message : err}`,
    );
  }
};
