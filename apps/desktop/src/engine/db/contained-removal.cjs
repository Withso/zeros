// The one containment check for deleting Zeros storage: the launcher prune,
// `pnpm storage:sweep` and the engine's own maintenance all use it. Plain
// CommonJS with Node built-ins so plain-Node scripts and the engine share it.
const fs = require("node:fs");
const path = require("node:path");

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Why `target` may not be removed, or null when it may. `target` must sit
 * directly inside `container`, which must be `root` or inside it, and no path
 * component from `root` down to `target` may be a symlink. */
function shapeRefusal(target, container, root) {
  if (typeof target !== "string" || !path.isAbsolute(target) || path.resolve(target) !== target)
    return "not an absolute normalized path";
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root) return "invalid root";
  if (path.dirname(target) !== container) return "outside its expected folder";
  if (container !== root && !container.startsWith(`${root}${path.sep}`)) return "outside the home folder";
  return null;
}

function refusal(target, { container, root, kind = "directory" }) {
  const shape = shapeRefusal(target, container, root);
  if (shape) return shape;
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    if (!segment || segment === "." || segment === "..") return "outside the home folder";
    cursor = path.join(cursor, segment);
    const stat = lstatOrNull(cursor);
    if (!stat) return "missing";
    if (stat.isSymbolicLink()) return "symlink";
    if (cursor !== target && !stat.isDirectory()) return "not a directory path";
  }
  const stat = lstatOrNull(target);
  if (kind === "directory" && !stat.isDirectory()) return "not a directory";
  if (kind === "file" && !stat.isFile()) return "not a file";
  return null;
}

/** Remove one contained target. Returns "removed", "missing" or a refusal. */
function removeContained(target, options) {
  const reason = refusal(target, options);
  if (reason) return reason;
  fs.rmSync(target, { recursive: options.kind !== "file", force: false });
  return "removed";
}

async function lstatOrNullAsync(target) {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** `refusal` without blocking the caller's event loop (Electron main, the
 * engine): the same checks through fs.promises. */
async function refusalAsync(target, { container, root, kind = "directory" }) {
  const shape = shapeRefusal(target, container, root);
  if (shape) return shape;
  let cursor = root;
  let stat = null;
  for (const segment of path.relative(root, target).split(path.sep)) {
    if (!segment || segment === "." || segment === "..") return "outside the home folder";
    cursor = path.join(cursor, segment);
    stat = await lstatOrNullAsync(cursor);
    if (!stat) return "missing";
    if (stat.isSymbolicLink()) return "symlink";
    if (cursor !== target && !stat.isDirectory()) return "not a directory path";
  }
  if (kind === "directory" && !stat.isDirectory()) return "not a directory";
  if (kind === "file" && !stat.isFile()) return "not a file";
  return null;
}

async function removeContainedAsync(target, options) {
  const reason = await refusalAsync(target, options);
  if (reason) return reason;
  await fs.promises.rm(target, { recursive: options.kind !== "file", force: false });
  return "removed";
}

module.exports = { refusal, removeContained, refusalAsync, removeContainedAsync };
