#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-deep-link-schemes — the web hub's allow-list must match the desktop's
// ──────────────────────────────────────────────────────────
//
// The desktop hands its channel's scheme to app.zeros.build in `?scheme=`; the
// hub and the invite page only echo it back if it is allow-listed. Those two
// sides live in different build systems (Electron app vs Cloudflare Pages) and
// ship on different cadences, so nothing linked them — and they silently drifted:
// `zeros-alpha` was added to src/engine/runtime.ts when the Alpha channel was
// created, but never to the web allow-list. Result: Alpha users got no "Launch
// Zeros" button, and every Alpha invite link opened the PRODUCTION app instead.
//
// A missing scheme fails closed (no button / wrong app), never loudly — so it
// survives until a human notices. This guard is the missing link.
//
//   DeepLinkScheme union in src/engine/runtime.ts
//     ===
//   SCHEMES in website/web-app/lib/schemes.mjs
//
// Textual on purpose: the web-app is a standalone npm package outside the pnpm
// workspace, so this script cannot import across that boundary.
// ──────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

const DESKTOP = "src/engine/runtime.ts";
const WEB = "website/web-app/lib/schemes.mjs";

function fail(msg) {
  console.error(`✗ check:deep-link-schemes — ${msg}`);
  process.exit(1);
}

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${file}`);
  }
}

// export type DeepLinkScheme = | "zeros" | "zeros-alpha" | …;
const union = read(DESKTOP).match(
  /export type DeepLinkScheme\s*=([\s\S]*?);/,
)?.[1];
if (!union)
  fail(
    `could not find the DeepLinkScheme union in ${DESKTOP} — did it get renamed? Update this guard.`,
  );
const desktop = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// export const SCHEMES = new Set([ "zeros", … ]);
const setBody = read(WEB).match(
  /export const SCHEMES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
)?.[1];
if (!setBody)
  fail(
    `could not find the SCHEMES Set in ${WEB} — did it get renamed? Update this guard.`,
  );
const web = [...setBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

if (desktop.length === 0 || web.length === 0)
  fail("parsed an empty scheme list — the guard would pass vacuously");

const missingOnWeb = desktop.filter((s) => !web.includes(s));
const extraOnWeb = web.filter((s) => !desktop.includes(s));

if (missingOnWeb.length || extraOnWeb.length) {
  console.error(`✗ check:deep-link-schemes — allow-lists have drifted:\n`);
  console.error(`  ${DESKTOP}  → ${desktop.join(", ")}`);
  console.error(`  ${WEB}      → ${web.join(", ")}\n`);
  for (const s of missingOnWeb)
    console.error(
      `  • "${s}" ships in the desktop but is NOT allow-listed on the web — that channel gets no "Launch Zeros" button and its invites open the wrong app.`,
    );
  for (const s of extraOnWeb)
    console.error(
      `  • "${s}" is allow-listed on the web but no desktop channel emits it — dead entry, or a channel that was removed.`,
    );
  console.error(
    `\nAdd it to ${WEB} (single source of truth for the web side).`,
  );
  process.exit(1);
}

console.log(
  `✓ check:deep-link-schemes — ${desktop.length} schemes match across desktop and web (${desktop.join(", ")}).`,
);
