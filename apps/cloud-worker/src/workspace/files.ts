import { constants } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { boundedInteger, commandRunner, type CommandRunner } from "./commands";
import { CheckedFiles, descriptorPath } from "./checked-files";
import { reqString, unsupported, WorkspaceError, type WorkspaceScope } from "./scope";

const TEXT_LIMIT = 2_000_000, IMAGE_LIMIT = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif", ".svg": "image/svg+xml" };
const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg", ".mkv": "video/x-matroska" };
const byBytes = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class FileService {
  readonly checked: CheckedFiles;
  private readonly run: CommandRunner;
  constructor(private readonly scope: WorkspaceScope, run?: CommandRunner, private readonly changed: () => void = () => {}) {
    this.run = run ?? commandRunner(scope.root); this.checked = new CheckedFiles(scope);
  }

  async handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
    for (const name of ["cwd", "folder", "repoRoot"]) if (params[name] !== undefined) this.scope.folder(params[name]);
    switch (op) {
      case "file.read": return this.read(typeof params.path === "string" ? params.path : "", params.includeVideo === true);
      case "file.write": {
        if (typeof params.content !== "string") throw new WorkspaceError("VALIDATION_FAILED", "File content must be text.");
        return this.write(typeof params.path === "string" ? params.path : "", params.content);
      }
      case "file.tree": {
        const args = ["ls-files", "--cached", "--others", ...(params.includeIgnored === true ? [] : ["--exclude-standard"]), "-z"];
        const { stdout } = await this.run("git", args, { readOnly: true });
        const query = typeof params.query === "string" ? params.query.toLowerCase() : "";
        const limit = boundedInteger(params.limit, 20_000, 100_000);
        const paths = [...new Set(stdout.split("\0").filter(Boolean))].filter(path => this.isFilePath(path) && path.toLowerCase().includes(query)).sort(byBytes).slice(0, limit);
        return { files: paths };
      }
      case "file.ignored": return { entries: await this.ignored(params) };
      case "fs.listDir": {
        const path = this.scope.path(params.path ?? this.scope.root, true);
        const handle = await this.checked.directory(path);
        try {
          const entries = [];
          for (const entry of await readdir(descriptorPath(handle), { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue;
            const candidate = join(path, entry.name);
            const child = await this.checked.directory(candidate).catch(() => null);
            if (child) { await child.close(); entries.push({ name: entry.name, path: candidate }); }
          }
          return { path, parent: path === this.scope.root ? null : dirname(path), entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
        } finally { await handle.close(); }
      }
      default: return unsupported();
    }
  }

  private isFilePath(path: string): boolean { try { this.scope.path(path); return true; } catch { return false; } }

  private async read(input: string, includeVideo = false): Promise<unknown> {
    let path = input;
    try {
      path = this.scope.relative(input);
      const file = await this.checked.file(input);
      try {
        const info = await file.stat(), extension = extname(path).toLowerCase();
        const videoMime = includeVideo ? VIDEO_TYPES[extension] : undefined;
        const mime = IMAGE_TYPES[extension] ?? videoMime;
        const limit = mime ? IMAGE_LIMIT : TEXT_LIMIT;
        if (info.size > limit) return { kind: "too-large", path, bytes: info.size };
        const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        await this.checked.assertDescriptor(file);
        if (bytesRead > limit) return { kind: "too-large", path, bytes: bytesRead };
        const data = buffer.subarray(0, bytesRead), bytes = data.length;
        if (mime) return { kind: videoMime ? "video" : "image", path, bytes, dataUrl: `data:${mime};base64,${data.toString("base64")}` };
        if (data.subarray(0, 8000).includes(0)) return { kind: "binary", path, bytes };
        return { kind: "text", path, bytes, content: data.toString("utf8") };
      } finally { await file.close(); }
    } catch { return { kind: "error", path, bytes: 0, error: "The file could not be read within this workspace." }; }
  }

  private async write(input: string, content: string): Promise<unknown> {
    let path = input;
    try {
      path = this.scope.relative(input);
      const bytes = Buffer.byteLength(content);
      if (bytes > TEXT_LIMIT) return { kind: "too-large", path, bytes };
      const { parent, mode } = await this.checked.writeParent(input);
      const temporary = `${descriptorPath(parent)}/.zeros-write-${randomUUID()}`;
      try {
        await this.checked.assertDescriptor(parent);
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
        try { await handle.writeFile(content, "utf8"); await handle.chmod(mode); await handle.sync(); }
        finally { await handle.close(); }
        await this.checked.assertDescriptor(parent);
        await rename(temporary, `${descriptorPath(parent)}/${basename(path)}`);
        await parent.sync(); this.changed();
        return { kind: "success", path, bytes };
      } finally { await rm(temporary, { force: true }).catch(() => {}); await parent.close(); }
    } catch { return { kind: "error", path, bytes: 0, error: "The file could not be written within this workspace." }; }
  }

  private async ignored(params: Record<string, unknown>): Promise<string[]> {
    const limit = boundedInteger(params.limit, 5000, 20_000);
    if (limit === 0) return [];
    if (params.dir !== undefined) {
      const path = this.scope.relative(reqString(params, "dir"));
      const handle = await this.checked.directory(path);
      try {
        return (await readdir(descriptorPath(handle), { withFileTypes: true })).filter(entry => entry.name !== ".git")
          .map(entry => `${path}/${entry.name}${entry.isDirectory() ? "/" : ""}`).sort(byBytes).slice(0, limit);
      } finally { await handle.close(); }
    }
    const { stdout } = await this.run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { readOnly: true });
    const collapsed: string[] = [], entries: string[] = [];
    for (const entry of stdout.split("\0").filter(Boolean).sort(byBytes)) {
      if (!this.isFilePath(entry) || collapsed.some(parent => entry.startsWith(parent))) continue;
      if (entry.endsWith("/")) {
        const handle = await this.checked.directory(entry).catch(() => null);
        if (!handle) continue;
        try { if (!(await readdir(descriptorPath(handle))).some(name => name !== ".git")) continue; }
        finally { await handle.close(); }
        collapsed.push(entry);
      }
      entries.push(entry); if (entries.length === limit) break;
    }
    return entries;
  }
}
