// The one containment check for deleting development storage: the launcher's
// bundle prune, the ephemeral-identity helper, bundle preparation and
// `pnpm storage:sweep`. These are developer tools a person or the dev launcher
// runs; no installed app deletes through this module. Plain CommonJS with Node
// built-ins so plain-Node scripts share it.
//
// Residual window: Node has no directory-handle (openat/unlinkat) removal, so a
// target is validated by path and then removed by path. A component swapped
// between the two by another process acting inside the same home is not
// detected. Every removal re-validates immediately before it runs.
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
 * directly inside `container`, which must be `root` or inside it; `root` must
 * be a real directory reached through no link at all, and no path component
 * from `root` down to `target` may be a symlink. */
function shapeRefusal(target, container, root) {
  if (typeof target !== "string" || !path.isAbsolute(target) || path.resolve(target) !== target)
    return "not an absolute normalized path";
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root) return "invalid root";
  if (path.dirname(target) !== container) return "outside its expected folder";
  if (container !== root && !container.startsWith(`${root}${path.sep}`)) return "outside the home folder";
  return null;
}

function anchorRefusal(anchor, real) {
  if (!anchor) return "missing";
  if (anchor.isSymbolicLink()) return "symlink";
  if (!anchor.isDirectory()) return "not a directory path";
  return real ? null : "linked ancestry";
}

function refusal(target, { container, root, kind = "directory" }) {
  const shape = shapeRefusal(target, container, root);
  if (shape) return shape;
  const anchor = lstatOrNull(root);
  let real = false;
  if (anchor?.isDirectory()) real = fs.realpathSync(root) === root;
  const unsafe = anchorRefusal(anchor, real);
  if (unsafe) return unsafe;
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

/** `refusal` through fs.promises, for the launcher's background prune. */
async function refusalAsync(target, { container, root, kind = "directory" }) {
  const shape = shapeRefusal(target, container, root);
  if (shape) return shape;
  const anchor = await lstatOrNullAsync(root);
  let real = false;
  if (anchor?.isDirectory()) real = (await fs.promises.realpath(root)) === root;
  const unsafe = anchorRefusal(anchor, real);
  if (unsafe) return unsafe;
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

module.exports = { refusal, removeContained, removeContainedAsync };
