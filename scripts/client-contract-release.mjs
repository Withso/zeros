// Keep a shipped release's control-plane contracts so the control plane replays
// them until that release leaves its support window: the desktop app's, and the
// cloud worker runtime's (the previous pin keeps talking to a new control plane
// during a handover). Copies <client>-next.json from the release tag, the exact
// files that release shipped with, and keeps the newest two per client.
//   pnpm client-contract:release 0.1.31
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIR = "apps/control-plane/src/client-contracts";
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const CLIENTS = ["desktop", "worker"];
const KEEP = 2;

const order = (a, b) => {
  const [x, y] = [a, b].map(v => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** One client's released files to delete so only the newest `keep` remain. */
export function prunable(names, client = "desktop", keep = KEEP) {
  const file = new RegExp(`^${client}-([0-9]+\\.[0-9]+\\.[0-9]+)\\.json$`);
  const versions = names.map(name => file.exec(name)?.[1]).filter(Boolean).sort(order);
  return versions.slice(0, Math.max(0, versions.length - keep)).map(version => `${client}-${version}.json`);
}

export function releaseClientContract(version, { root = process.cwd(), git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) } = {}) {
  if (!VERSION.test(version ?? "")) throw new Error("Usage: pnpm client-contract:release X.Y.Z");
  const released = path.join(root, DIR, "released"), written = [], skipped = [];
  for (const client of CLIENTS) {
    let contract;
    try {
      contract = git(["show", `v${version}:${DIR}/${client}-next.json`]);
    } catch {
      // A tag cut before this client declared a contract has nothing to keep.
      if (client === "desktop") throw new Error(`v${version} has no desktop client contract`);
      skipped.push(client);
      continue;
    }
    const parsed = JSON.parse(contract);
    if (parsed.version !== 1 || parsed.client !== client) throw new Error(`v${version} has no ${client} client contract`);
    writeFileSync(path.join(released, `${client}-${version}.json`), contract);
    written.push(`${client}-${version}.json`);
  }
  const names = readdirSync(released), removed = CLIENTS.flatMap(client => prunable(names, client));
  for (const name of removed) rmSync(path.join(released, name));
  return { written, skipped, removed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { written, skipped, removed } = releaseClientContract(process.argv[2]);
    console.log(`✓ kept ${written.join(", ")}${skipped.length ? `; tag has no ${skipped.join(", ")} contract` : ""}${removed.length ? `; removed ${removed.join(", ")}` : ""}`);
  } catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
