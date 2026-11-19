#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// electron-builder-run — channel-aware packaging entry
// ──────────────────────────────────────────────────────────
//
// Packages the app with electron-builder, applying per-channel identity so an
// Alpha build installs as a SEPARATE macOS app alongside the production app
// (own appId → own bundle, own ~/Library/Application Support, own dock entry).
//
// Channel comes from ZEROS_CHANNEL (default "stable"):
//   • stable → electron-builder.yml verbatim (appId com.zeros · "Zeros").
//             ZERO overrides, so the proven prod artifacts are byte-identical.
//   • alpha  → override appId/productName + a space-free artifact base so the
//             filenames the alpha release uploads (and alpha-mac.yml references)
//             stay clean: "Zeros-Alpha-<version>-<arch>.dmg". Alpha is the build
//             cut from EVERY merge to main and must be installable alongside
//             Production, which is why it owns an appId.
//
// electron-builder.yml is NOT templated — it stays usable on its own (release.yml,
// scheduled.yml, and the asarUnpack/path checks all read it directly). All the
// channel logic lives here. The ${version}/${arch}/${ext} tokens below are
// electron-builder artifactName macros (NOT shell vars) — passed as discrete
// argv entries so no shell expands them.
//
// Pass-through: any extra args go straight to electron-builder, e.g.
//   node scripts/electron-builder-run.mjs --publish never
//   ZEROS_CHANNEL=alpha node scripts/electron-builder-run.mjs --publish never

import { spawnSync } from "node:child_process";

const channel = process.env.ZEROS_CHANNEL || "stable";

const OVERRIDES = {
  // Production: no overrides — use electron-builder.yml exactly as written.
  stable: [],
  // Alpha: the continuous channel built from every merge to main, with its own
  // identity, dock icon and feed prefix so an installed Alpha never updates
  // itself into Production.
  alpha: [
    "-c.appId=com.zeros.alpha",
    "-c.productName=Zeros Alpha",
    "-c.mac.icon=build/icons/icon-alpha.icns",
    // Must be explicit: electron-builder does NOT derive the channel from an
    // -alpha version (it defaults to "latest"), and without this the build writes
    // latest-mac.yml and the release workflow's alpha-mac.yml guard fails.
    "-c.publish.channel=alpha",
    // The rolling `alpha` release tag, not electron-builder.yml's
    // /releases/latest/download URL. Runtime setFeedURL in apps/desktop/electron/updater.ts
    // points at the same base; this keeps the baked app-update.yml truthful too.
    // `?static=1` pins electron-updater's per-poll noCache query off (see the
    // publish block comment in electron-builder.yml).
    "-c.publish.url=https://github.com/Withso/zeros/releases/download/alpha?static=1",
    "-c.dmg.artifactName=Zeros-Alpha-${version}-${arch}.${ext}",
    "-c.mac.artifactName=Zeros-Alpha-${version}-${arch}-mac.${ext}",
  ],
};

const overrides = OVERRIDES[channel];
if (!overrides) {
  console.error(
    `[electron-builder-run] cannot package channel "${channel}" — use one of: ` +
      `${Object.keys(OVERRIDES).join(", ")} ` +
      `(dev is unpackaged: run \`pnpm electron:dev\`).`,
  );
  process.exit(1);
}

const passthrough = process.argv.slice(2);
const args = [
  "exec",
  "electron-builder",
  "--config",
  "electron-builder.yml",
  ...overrides,
  ...passthrough,
];

console.log(`[electron-builder-run] channel=${channel}`);
const res = spawnSync("pnpm", args, {
  stdio: "inherit",
  // Re-export the resolved channel so the bake (electron:compile, if a caller
  // chains it) and any nested tooling see the same value.
  env: { ...process.env, ZEROS_CHANNEL: channel },
});
process.exit(res.status ?? 1);
