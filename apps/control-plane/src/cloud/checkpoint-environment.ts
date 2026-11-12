import { CLOUD_ENVIRONMENT_LIMITS } from "./environment-contract.js";

/** Executed only with the worker quiesced. Copy selected bytes through held
 * descriptors so tar never follows a later symlink or traverses ignored trees. */
export const ENVIRONMENT_CHECKPOINT_SCRIPT = String.raw`
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
const limits = __LIMITS__;
const [mode, root, source, output] = process.argv.slice(2);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.exec(value)?.[0] === value;
const validPath = value => typeof value === "string" && Buffer.byteLength(value) <= limits.pathBytes &&
  /^(?:[A-Za-z0-9_.-]+\/)*\.env(?:\.[A-Za-z0-9_.-]+)?$/.exec(value)?.[0] === value && value.split("/").length <= 16 &&
  !value.split("/").some(part => [".", "..", ".git", ".zeros", ".context", ".context-graph", ".local", "node_modules"].includes(part));
const info = path => { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } };
const read = (path, maximum) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new Error();
    if (before.size > maximum) process.exit(3);
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, length); if (!n) break; length += n; }
    const after = fstatSync(fd);
    if (length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw new Error();
    return { bytes: bytes.subarray(0, length), mode: before.mode & 0o777 };
  } finally { closeSync(fd); }
};
const json = (path, maximum) => JSON.parse(read(path, maximum).bytes.toString("utf8"));
const parent = (path, create) => {
  let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of path.split("/").slice(0, -1)) {
      const child = "/proc/self/fd/" + fd + "/" + part;
      if (!info(child)) { if (!create) { closeSync(fd); return undefined; } mkdirSync(child, { mode: 0o700 }); }
      const next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
      if (info("/proc/self/fd/" + fd + "/.git")) throw new Error();
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
};
try {
  if (mode === "capture") {
    if (!info(source)) process.exit(0);
    const journal = json(source, 32768);
    if (![1, 2].includes(journal.version) || !uuid(journal.versionId) || typeof journal.complete !== "boolean" ||
        !Array.isArray(journal.files) || journal.files.length > limits.files || new Set(journal.files.map(file => file.path)).size !== journal.files.length) throw new Error();
    mkdirSync(output, { mode: 0o700 });
    const entries = []; let total = 0;
    for (const file of journal.files) {
      if (!validPath(file.path) || !uuid(file.alias) || !["preparing", "prepared", "publishing", "complete"].includes(file.phase)) throw new Error();
      const fd = parent(file.path, false);
      try {
        const path = fd === undefined ? undefined : "/proc/self/fd/" + fd + "/" + file.path.split("/").at(-1);
        if (!path || !info(path)) { entries.push({ path: file.path, state: "missing" }); continue; }
        const held = read(path, limits.fileBytes); total += held.bytes.length;
        if (total > limits.totalBytes) process.exit(3);
        const name = "file-" + entries.length;
        writeFileSync(output + "/" + name, held.bytes, { flag: "wx", mode: 0o600 });
        entries.push({ path: file.path, state: "file", name, mode: held.mode });
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    writeFileSync(output + "/manifest.json", JSON.stringify({ version: 1, entries }), { flag: "wx", mode: 0o600 });
  } else if (mode === "restore" || mode === "exclude") {
    const manifest = json(source + "/manifest.json", 32768);
    if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > limits.files ||
        new Set(manifest.entries.map(entry => entry.path)).size !== manifest.entries.length) throw new Error();
    if (mode === "exclude") {
      if (manifest.entries.some(entry => !validPath(entry.path) || !["file", "missing"].includes(entry.state))) throw new Error();
      writeFileSync(output, manifest.entries.flatMap(entry => [entry.path, "./" + entry.path]).join("\n") + "\n", { flag: "wx", mode: 0o600 });
      process.exit(0);
    }
    let total = 0;
    for (const [index, entry] of manifest.entries.entries()) {
      if (!validPath(entry.path) || !["file", "missing"].includes(entry.state)) throw new Error();
      let held;
      if (entry.state === "file") {
        if (entry.name !== "file-" + index || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 511) throw new Error();
        held = read(source + "/" + entry.name, limits.fileBytes); total += held.bytes.length;
        if (total > limits.totalBytes) process.exit(3);
      }
      const fd = parent(entry.path, entry.state === "file");
      if (fd === undefined) continue;
      try {
        const path = "/proc/self/fd/" + fd + "/" + entry.path.split("/").at(-1), prior = info(path);
        if (prior && !prior.isFile()) throw new Error();
        if (!held) { if (prior) unlinkSync(path); continue; }
        const candidate = "/proc/self/fd/" + fd + "/.zeros-environment-" + randomUUID();
        writeFileSync(candidate, held.bytes, { flag: "wx", mode: 0o600 }); chmodSync(candidate, entry.mode);
        renameSync(candidate, path);
      } finally { closeSync(fd); }
    }
  } else throw new Error();
} catch { process.exit(2); }
`.replace("__LIMITS__", JSON.stringify(CLOUD_ENVIRONMENT_LIMITS));
