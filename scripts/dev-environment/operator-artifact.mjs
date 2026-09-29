import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSync } from "esbuild";
import { gzipSync, gunzipSync } from "node:zlib";
import { sha256, writePrivateFile } from "./state.mjs";

const ALLOWED = /^(?:dist\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:js|json)|migrations\/[a-zA-Z0-9_-]+\.sql|package\.json)$/;
export function packDevOperator(root) {
  const base = path.join(root, "apps/control-plane"), files = {};
  for (const name of fs.readdirSync(base, { recursive: true })) {
    if (typeof name !== "string" || !ALLOWED.test(name)) continue;
    const file = path.join(base, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid Dev operator artifact input");
    files[name] = fs.readFileSync(file).toString("base64");
  }
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dev-operator-build-"));
  try {
    // Bundle the locked installed dependencies into each recorded operator.
    // Root-level chunks preserve migration paths relative to dist/.
    buildSync({ entryPoints: Object.keys(files).filter(name => name.startsWith("dist/") && name.endsWith(".js")).map(name => path.join(base, name)),
      outbase: path.join(base, "dist"), outdir: output, bundle: true, splitting: true, format: "esm", platform: "node", target: "node22",
      chunkNames: "operator-[hash]", external: ["pg-native", "bufferutil", "utf-8-validate"], logLevel: "silent",
      banner: { js: 'import { createRequire as zerosDevRequire } from "node:module"; const require = zerosDevRequire(import.meta.url);' } });
    for (const name of Object.keys(files)) if (name.startsWith("dist/") && name.endsWith(".js")) delete files[name];
    for (const name of fs.readdirSync(output, { recursive: true })) {
      const file = path.join(output, name); if (fs.statSync(file).isFile()) files[`dist/${name}`] = fs.readFileSync(file).toString("base64");
    }
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
  const body = gzipSync(JSON.stringify({ version: 2, nodeMajor: 22, files }));
  if (body.length > 8 * 1024 * 1024) throw new Error("Dev operator artifact exceeds its size budget");
  return { body, digest: sha256(body) };
}

export function unpackDevOperator(body, expected, destination, root) {
  if (body.length > 8 * 1024 * 1024 || sha256(body) !== expected) throw new Error("Dev operator artifact checksum mismatch");
  const artifact = JSON.parse(gunzipSync(body, { maxOutputLength: 64 * 1024 * 1024 }).toString());
  const files = artifact.version === 2 ? artifact.files : artifact;
  if (!files["dist/db.js"] || !files["dist/migrate.js"] || !files["package.json"]) throw new Error("Incomplete Dev operator artifact");
  const base = path.join(destination, "apps/control-plane");
  for (const [name, encoded] of Object.entries(files)) {
    if (!ALLOWED.test(name) || typeof encoded !== "string") throw new Error("Invalid Dev operator artifact path");
    const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivateFile(file, Buffer.from(encoded, "base64"));
  }
  // Preserve v1 cleanup compatibility explicitly. Hosted scheduling quarantines
  // these old artifacts unless a matching, retained dependency installation is supplied.
  if (artifact.version !== 2) {
    if (!root || !fs.existsSync(path.join(root, "apps/control-plane/node_modules"))) throw new Error("Legacy Dev operator requires its retained dependency installation; use explicit reconciliation");
    fs.symlinkSync(path.join(root, "apps/control-plane/node_modules"), path.join(base, "node_modules"), "dir");
  }
  return { directory: destination };
}
