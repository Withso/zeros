import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

export const PRIVATE_DEV_FILES = [
  "**/.env", "**/.env.*", "**/*.{crt,pem,key,p12,pfx,cer,der}", "**/.npmrc", "**/.yarnrc.yml", "**/.git/**", "**/.context/**",
  "**/.conductor/**", "**/.zeros/**", "**/zeros-dev-env.json", "**/*.{db,sqlite,db-wal,db-shm}",
];

export function isPrivateDevPath(file) {
  return file.split(/[\\/]/).some(part =>
    [".git", ".context", ".conductor", ".zeros", "zeros-dev-env.json", ".env", ".npmrc", ".yarnrc.yml"].includes(part.toLowerCase()) ||
    part.toLowerCase().startsWith(".env.") || /\.(?:crt|pem|key|p12|pfx|cer|der|db|sqlite|db-wal|db-shm)$/i.test(part));
}

const within = (root, file) => file === root || file.startsWith(root + path.sep);

/** Shared by the two Vite apps. Defaults remain usable without a network.
 * A protected remote preview explicitly names its bind address and hosts. */
export function developmentServerOptions(allow, env = process.env) {
  const host = env.ZEROS_DEV_BIND_HOST || "localhost";
  const allowedHosts = (env.ZEROS_DEV_PREVIEW_HOSTS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (allowedHosts.some(value => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)))
    throw new Error("Preview hosts must be exact hostnames, without scheme, port or wildcard");
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !allowedHosts.length)
    throw new Error("A non-loopback development bind requires ZEROS_DEV_PREVIEW_HOSTS");
  return { host, allowedHosts, fs: { strict: true, allow, deny: PRIVATE_DEV_FILES } };
}

/** Vite's public directory bypasses fs.deny; aliases and symlinks must be
 * checked against their resolved files as well as their request names. */
export function developmentFileBoundary(allow) {
  const roots = allow.map(value => path.resolve(value));
  const permitted = file => {
    if (isPrivateDevPath(file) || !roots.some(root => within(root, file))) return false;
    try {
      const real = realpathSync(file);
      return !isPrivateDevPath(real) && roots.some(root => within(root, real));
    } catch { return true; }
  };
  return {
    name: "zeros-development-file-boundary",
    apply: "serve",
    enforce: "pre",
    load(id) {
      // plugin-react owns this exact virtual ID; it is not a filesystem path.
      // Do not exempt the /@ namespace, query variants, or neighboring files.
      if (id === "/@react-refresh") return;
      const file = id.split(/[?#]/, 1)[0];
      if (path.isAbsolute(file) && !permitted(file)) throw new Error("File is outside the development serving boundary");
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let url;
        try { url = decodeURIComponent((req.url || "/").split("?", 1)[0]); }
        catch { res.statusCode = 400; res.end("Bad request"); return; }
        const deny = () => { res.statusCode = 403; res.end("Forbidden"); };
        if (isPrivateDevPath(url) || url.includes("\0") || url.includes("\\")) return deny();
        if (url.startsWith("/@fs/")) {
          if (!permitted(path.resolve(url.slice(5)))) return deny();
        } else if (!url.startsWith("/@")) {
          for (const root of [server.config.root, server.config.publicDir].filter(Boolean)) {
            const file = path.resolve(root, "." + (url === "/" ? "/index.html" : url));
            if (existsSync(file) && !permitted(file)) return deny();
          }
        }
        next();
      });
    },
  };
}
