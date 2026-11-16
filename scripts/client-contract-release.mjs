// Keep a shipped desktop's control-plane contract so the control plane replays
// it until that app leaves its support window. Copies desktop-next.json from the
// release tag (the exact file that release shipped with) and keeps the newest two.
//   pnpm client-contract:release 0.1.31
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIR = "apps/control-plane/src/client-contracts";
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const FILE = /^desktop-([0-9]+\.[0-9]+\.[0-9]+)\.json$/;
const KEEP = 2;

const order = (a, b) => {
  const [x, y] = [a, b].map(v => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Released contract files to delete so only the newest `keep` remain. */
export function prunable(names, keep = KEEP) {
  const versions = names.map(name => FILE.exec(name)?.[1]).filter(Boolean).sort(order);
  return versions.slice(0, Math.max(0, versions.length - keep)).map(version => `desktop-${version}.json`);
}

export function releaseClientContract(version, { root = process.cwd(), git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }) } = {}) {
  if (!VERSION.test(version ?? "")) throw new Error("Usage: pnpm client-contract:release X.Y.Z");
  const contract = git(["show", `v${version}:${DIR}/desktop-next.json`]);
  const parsed = JSON.parse(contract);
  if (parsed.version !== 1 || parsed.client !== "desktop") throw new Error(`v${version} has no desktop client contract`);
  const released = path.join(root, DIR, "released");
  writeFileSync(path.join(released, `desktop-${version}.json`), contract);
  const removed = prunable(readdirSync(released));
  for (const name of removed) rmSync(path.join(released, name));
  return { written: `desktop-${version}.json`, removed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { written, removed } = releaseClientContract(process.argv[2]);
    console.log(`✓ kept ${written}${removed.length ? `; removed ${removed.join(", ")}` : ""}`);
  } catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
