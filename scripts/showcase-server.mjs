import http from "node:http";
import path from "node:path";
import { constants, openSync, closeSync, readSync, fstatSync, realpathSync } from "node:fs";
import { isPrivateDevPath } from "./dev-server-policy.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

function openWithoutSymlinks(file) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  // Darwin's O_NOFOLLOW_ANY rejects symlinks in every path component.
  if (process.platform === "darwin") return openSync(file, flags | 0x20000000);
  if (process.platform !== "linux") throw new Error("Safe showcase reads are unavailable on this platform");
  // Resolve each component relative to an already opened directory. O_NOFOLLOW
  // on the final file alone does not protect a parent replaced after realpath.
  const components = file.split(path.sep).filter(Boolean);
  let parent = openSync(path.sep, flags | constants.O_DIRECTORY);
  try {
    for (const component of components.slice(0, -1)) {
      const next = openSync(`/proc/self/fd/${parent}/${component}`, flags | constants.O_DIRECTORY);
      closeSync(parent);
      parent = next;
    }
    return openSync(`/proc/self/fd/${parent}/${components.at(-1)}`, flags);
  } finally { closeSync(parent); }
}

export function showcaseMiddleware(directory, { standalone = false } = {}) {
  const root = realpathSync(directory);
  return (req, res, next = () => { res.statusCode = 404; res.end("Not found"); }) => {
    let name;
    try { name = decodeURIComponent((req.url || "/").split("?", 1)[0]); }
    catch { res.statusCode = 400; res.end("Bad request"); return; }
    const prefix = /^(?:\/loaders|\/styles\/Artifacts)(?:\/|$)/i;
    if (!standalone && !prefix.test(name)) return next();
    name = name.replace(prefix, "").replace(/^\//, "");
    if (!name) name = "loaders-preview.html";
    if (!["GET", "HEAD"].includes(req.method) || isPrivateDevPath(name) || name.includes("\\") || name.split("/").includes("..") || !MIME[path.extname(name)]) {
      res.statusCode = 403; res.end("Forbidden"); return;
    }
    let fd;
    try {
      const file = realpathSync(path.join(root, name));
      if (!file.startsWith(root + path.sep) || isPrivateDevPath(file)) { res.statusCode = 403; res.end("Forbidden"); return; }
      fd = openWithoutSymlinks(file);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) { res.statusCode = 403; res.end("Forbidden"); return; }
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) { const size = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!size) break; offset += size; }
      res.setHeader("Content-Type", MIME[path.extname(name)]);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? undefined : bytes.subarray(0, offset));
    } catch { res.statusCode = 404; res.end("Not found"); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
}

export function createShowcaseServer(directory) {
  const serve = showcaseMiddleware(directory, { standalone: true });
  return http.createServer((req, res) => {
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { host = ""; }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) { res.statusCode = 403; res.end("Forbidden"); return; }
    serve(req, res);
  });
}
