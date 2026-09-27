import fs from "node:fs";
import path from "node:path";
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
  const body = gzipSync(JSON.stringify(files));
  if (body.length > 8 * 1024 * 1024) throw new Error("Dev operator artifact exceeds its size budget");
  return { body, digest: sha256(body) };
}

export function unpackDevOperator(body, expected, destination, root) {
  if (body.length > 8 * 1024 * 1024 || sha256(body) !== expected) throw new Error("Dev operator artifact checksum mismatch");
  const files = JSON.parse(gunzipSync(body, { maxOutputLength: 64 * 1024 * 1024 }).toString());
  if (!files["dist/db.js"] || !files["dist/migrate.js"] || !files["package.json"]) throw new Error("Incomplete Dev operator artifact");
  const base = path.join(destination, "apps/control-plane");
  for (const [name, encoded] of Object.entries(files)) {
    if (!ALLOWED.test(name) || typeof encoded !== "string") throw new Error("Invalid Dev operator artifact path");
    const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivateFile(file, Buffer.from(encoded, "base64"));
  }
  fs.symlinkSync(path.join(root, "apps/control-plane/node_modules"), path.join(base, "node_modules"), "dir");
  return { directory: destination };
}
