// Bench only: maps the stacks a bench report captured to source positions.
// node scripts/phase1-map-stacks.mjs <evidence folder>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require("source-map-js");
const folder = process.argv[2];
const report = JSON.parse(fs.readFileSync(path.join(folder, "report.json"), "utf8"));
const assets = path.join(folder, "app", "dist", "assets");
const maps = new Map();
const consumer = (file) => {
  if (!maps.has(file)) {
    const map = path.join(assets, `${file}.map`);
    maps.set(file, fs.existsSync(map) ? new SourceMapConsumer(JSON.parse(fs.readFileSync(map, "utf8"))) : null);
  }
  return maps.get(file);
};
for (const [index, stack] of (report.fixtures[0]?.selectionStacks ?? []).entries()) {
  console.log(`--- stack ${index}`);
  for (const line of stack.split("\n")) {
    const match = /\/assets\/([^/:?]+\.js):(\d+):(\d+)/.exec(line);
    const map = match && consumer(match[1]);
    if (!map) { console.log("  ", line.trim().slice(0, 140)); continue; }
    const at = map.originalPositionFor({ line: Number(match[2]), column: Number(match[3]) - 1 });
    console.log(`   ${at.name ?? "?"} ${String(at.source).split("/apps/desktop/src/").pop()}:${at.line}`);
  }
}
