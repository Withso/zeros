#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-electron-hardening — assert the Electron security posture can't regress
// ──────────────────────────────────────────────────────────
//
// The app's hardening is correct TODAY (contextIsolation + sandbox + no
// nodeIntegration, a window-open/navigation guard, a CSP, and a contextBridge-only
// preload). The highest-impact desktop vuln is a renderer XSS escalating to full
// RCE on the user's machine — one careless edit away (someone flips sandbox:false
// "to debug", adds a window without the flags, drops the nav guard). This static
// guard encodes the posture as a regression test. It is intentionally narrow (the
// 6 load-bearing invariants) so it doesn't fight the deliberate iframe-header
// design. Run: `pnpm check:electron-hardening`. Exit 0 = posture intact, 1 = a
// hardening invariant regressed.
// ──────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

const main = readFileSync("electron/main.ts", "utf8");
const preload = readFileSync("electron/preload.ts", "utf8");

const errs = [];

// Required posture in main.ts.
const required = [
  [/contextIsolation:\s*true/, "contextIsolation: true (renderer can't reach Node)"],
  [/nodeIntegration:\s*false/, "nodeIntegration: false"],
  [/sandbox:\s*true/, "sandbox: true"],
  [/setWindowOpenHandler/, "setWindowOpenHandler (deny/triage window.open targets)"],
  [/["']will-navigate["']/, "will-navigate guard (block in-page navigation away)"],
  [/Content-Security-Policy/, "Content-Security-Policy injection"],
];
for (const [re, label] of required) {
  if (!re.test(main)) errs.push(`electron/main.ts: missing hardening — ${label}`);
}
// Preload must only bridge via contextBridge.
if (!/contextBridge\.exposeInMainWorld/.test(preload)) {
  errs.push("electron/preload.ts: missing contextBridge.exposeInMainWorld (the only safe renderer bridge)");
}

// Banned anti-patterns anywhere in main.ts.
const banned = [
  [/webSecurity:\s*false/, "webSecurity: false"],
  [/allowRunningInsecureContent:\s*true/, "allowRunningInsecureContent: true"],
  [/nodeIntegration:\s*true/, "nodeIntegration: true"],
  [/nodeIntegrationInWorker:\s*true/, "nodeIntegrationInWorker: true"],
  [/enableRemoteModule:\s*true/, "enableRemoteModule: true"],
  [/sandbox:\s*false/, "sandbox: false"],
];
for (const [re, label] of banned) {
  if (re.test(main)) errs.push(`electron/main.ts: BANNED setting present — ${label}`);
}

if (errs.length > 0) {
  console.error("✖ check:electron-hardening — security posture regressed:");
  for (const e of errs) console.error(`  • ${e}`);
  process.exit(1);
}
console.log("✓ check:electron-hardening — contextIsolation + sandbox + nav guards + CSP + contextBridge all intact");
