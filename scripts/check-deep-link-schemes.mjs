#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-deep-link-schemes — the web hub's allow-list must match the desktop's
// ──────────────────────────────────────────────────────────
//
// The desktop hands its channel's scheme to app.zeros.build in `?scheme=`; the
// hub and the invite page only echo it back if it is allow-listed. Those two
// sides live in different build systems (Electron app vs Cloudflare Pages) and
// ship on different cadences, so nothing linked them — and they silently drifted:
// `zeros-alpha` was added to apps/desktop/src/engine/runtime.ts when the Alpha channel was
// created, but never to the web allow-list. Result: Alpha users got no "Launch
// Zeros" button, and every Alpha invite link opened the PRODUCTION app instead.
//
// A missing scheme fails closed (no button / wrong app), never loudly — so it
// survives until a human notices. This guard is the missing link.
//
//   DeepLinkScheme union in apps/desktop/src/engine/runtime.ts
//     ===
//   SCHEMES in apps/web/lib/schemes.mjs
//     ===
//   DESKTOP_SCHEMES in apps/control-plane/src/workos-desktop-authorization.ts
//
// Textual on purpose: the web hub is a standalone npm package outside the pnpm
// workspace, so this script cannot import across that boundary.
// ──────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

const DESKTOP = "apps/desktop/src/engine/runtime.ts";
const WEB = "apps/web/lib/schemes.mjs";
const CONTROL_PLANE =
  "apps/control-plane/src/workos-desktop-authorization.ts";

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

function parseSet(file, name, exported = false) {
  const prefix = exported ? "export\\s+" : "";
  const body = read(file).match(
    new RegExp(`${prefix}const\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`),
  )?.[1];
  if (!body)
    fail(
      `could not find the ${name} Set in ${file} — did it get renamed? Update this guard.`,
    );
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const web = parseSet(WEB, "SCHEMES", true);
const controlPlane = parseSet(CONTROL_PLANE, "DESKTOP_SCHEMES");

if (desktop.length === 0 || web.length === 0 || controlPlane.length === 0)
  fail("parsed an empty scheme list — the guard would pass vacuously");

const missingOnWeb = desktop.filter((s) => !web.includes(s));
const extraOnWeb = web.filter((s) => !desktop.includes(s));
const missingOnControlPlane = desktop.filter((s) => !controlPlane.includes(s));
const extraOnControlPlane = controlPlane.filter((s) => !desktop.includes(s));

if (
  missingOnWeb.length ||
  extraOnWeb.length ||
  missingOnControlPlane.length ||
  extraOnControlPlane.length
) {
  console.error(`✗ check:deep-link-schemes — allow-lists have drifted:\n`);
  console.error(`  ${DESKTOP}  → ${desktop.join(", ")}`);
  console.error(`  ${WEB}      → ${web.join(", ")}\n`);
  console.error(`  ${CONTROL_PLANE} → ${controlPlane.join(", ")}\n`);
  for (const s of missingOnWeb)
    console.error(
      `  • "${s}" ships in the desktop but is NOT allow-listed on the web — that channel gets no "Launch Zeros" button and its invites open the wrong app.`,
    );
  for (const s of extraOnWeb)
    console.error(
      `  • "${s}" is allow-listed on the web but no desktop channel emits it — dead entry, or a channel that was removed.`,
    );
  for (const s of missingOnControlPlane)
    console.error(
      `  • "${s}" ships in the desktop but is NOT allow-listed by Railway — that channel cannot start desktop authentication.`,
    );
  for (const s of extraOnControlPlane)
    console.error(
      `  • "${s}" is allow-listed by Railway but no desktop channel emits it — dead entry, or a channel that was removed.`,
    );
  console.error(
    `\nKeep ${WEB} and ${CONTROL_PLANE} aligned with ${DESKTOP}.`,
  );
  process.exit(1);
}

console.log(
  `✓ check:deep-link-schemes — ${desktop.length} schemes match across desktop, web, and control plane (${desktop.join(", ")}).`,
);
