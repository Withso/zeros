#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Zeros doctor — one-shot memory / process census (`pnpm doctor`)
// ──────────────────────────────────────────────────────────
//
// The engine self-logs `[Zeros mem]` (its own rss) and main logs `[Zeros
// procmem]` (this app's Chromium tree), but neither sees the WHOLE picture:
// multiple dev instances, sibling vite/tsup/esbuild, and — the thing that bit us
// — LEAKED subprocesses (cursor-agent / engines reparented to launchd, ppid=1)
// that survive app restarts and quietly hold GBs.
//
// This walks `ps` once and prints: how many instances / engines are live, how
// many orphaned (ppid=1) engine/agent/host processes are leaking, the total RSS
// of the whole Zeros footprint, and the biggest offenders. Run it whenever RAM
// looks wrong. Read-only; it kills nothing (pass --kill-orphans to reap the
// ppid=1 leaks it finds).
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";

const KILL = process.argv.includes("--kill-orphans");

function snapshot() {
  // pid ppid rss(KB) command — one row per process.
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,ppid=,rss=,comm=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`[doctor] ps failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssMb: Number(m[3]) / 1024,
      command: m[4],
    });
  }
  return rows;
}

/** Classify a process into a Zeros category, or null if it isn't ours. */
function classify(r) {
  const c = r.command;
  if (/Electron Helper/.test(c) && /dev-instances|com\.zeros|Zeros/.test(c))
    return "electron-helper";
  if (
    c.startsWith("/") &&
    /\/Contents\/MacOS\/Zeros/.test(c) &&
    !/Electron Helper/.test(c)
  )
    return "electron-main";
  if (/zeros-engine/.test(c) || (/\bbun\b/.test(c) && /src\/cli\.ts serve/.test(c)))
    return "engine";
  if (/cursor-host\.cjs/.test(c)) return "cursor-host";
  if (/pty-host\.cjs/.test(c)) return "pty-host";
  if (/cursor-agent\b/.test(c) && /\bacp\b/.test(c)) return "cursor-agent";
  if (/\/vite\/bin\/vite|vite\.js/.test(c)) return "vite";
  if (/\btsup\b/.test(c) && /dev-instances|Zeros|electron\/tsup|src\/cli/.test(c))
    return "tsup";
  if (/dev-instance\.mjs/.test(c)) return "dev-launcher";
  return null;
}

// Categories whose processes should have a live Zeros parent — a ppid of 1
// (reparented to launchd/init) means the parent died and this is a LEAK.
const ORPHANABLE = new Set(["engine", "cursor-agent", "cursor-host", "pty-host"]);

const rows = snapshot();
const mine = rows
  .map((r) => ({ ...r, cat: classify(r) }))
  .filter((r) => r.cat);

const byCat = new Map();
for (const r of mine) {
  const cur = byCat.get(r.cat) ?? { n: 0, mb: 0 };
  cur.n += 1;
  cur.mb += r.rssMb;
  byCat.set(r.cat, cur);
}

const orphans = mine.filter((r) => r.ppid === 1 && ORPHANABLE.has(r.cat));
const instances = (byCat.get("electron-main")?.n ?? 0);
const totalMb = mine.reduce((s, r) => s + r.rssMb, 0);

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

console.log("\n  " + bold("Zeros doctor") + " — process & memory census\n");
console.log(`  live dev instances (electron-main): ${bold(String(instances))}`);
console.log(`  total Zeros footprint:              ${bold(totalMb.toFixed(0) + " MB")}`);
console.log(
  `  orphaned (ppid=1) leaks:            ${
    orphans.length ? red(String(orphans.length)) : green("0")
  }\n`,
);

const catOrder = [
  "electron-main",
  "electron-helper",
  "engine",
  "cursor-host",
  "pty-host",
  "cursor-agent",
  "vite",
  "tsup",
  "dev-launcher",
];
console.log("  " + dim("by category (count / RSS):"));
for (const cat of catOrder) {
  const v = byCat.get(cat);
  if (!v) continue;
  console.log(`    ${cat.padEnd(18)} ${String(v.n).padStart(3)}  ${v.mb.toFixed(0).padStart(6)} MB`);
}

console.log("\n  " + dim("top 12 by RSS:"));
for (const r of [...mine].sort((a, b) => b.rssMb - a.rssMb).slice(0, 12)) {
  const flag = r.ppid === 1 && ORPHANABLE.has(r.cat) ? red(" ORPHAN") : "";
  console.log(
    `    ${r.rssMb.toFixed(0).padStart(6)} MB  ${r.cat.padEnd(16)} pid=${String(r.pid).padStart(6)}${flag}`,
  );
}

if (orphans.length) {
  console.log(
    "\n  " +
      red(`${orphans.length} orphaned process(es) leaking ${orphans.reduce((s, r) => s + r.rssMb, 0).toFixed(0)} MB`) +
      " — reparented to launchd after their engine died:",
  );
  for (const r of orphans) {
    console.log(`    pid=${String(r.pid).padStart(6)}  ${r.cat.padEnd(14)} ${r.rssMb.toFixed(0)} MB`);
  }
  if (KILL) {
    let killed = 0;
    for (const r of orphans) {
      try {
        process.kill(r.pid, "SIGKILL");
        killed += 1;
      } catch {
        /* already gone / perms */
      }
    }
    console.log(`\n  ${green(`reaped ${killed} orphan(s).`)}`);
  } else {
    console.log(`\n  ${dim("run `pnpm doctor --kill-orphans` to reap them.")}`);
  }
}

if (instances > 3) {
  console.log(
    "\n  " +
      dim(
        `${instances} instances running — each full stack is ~550 MB. Use ` +
          "`pnpm electron:run` (run-only) for worktrees you're not editing.",
      ),
  );
}
console.log("");
