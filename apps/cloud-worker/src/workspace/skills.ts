import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CheckedFiles, descriptorPath } from "./checked-files";
import { WorkspaceError, WorkspaceScope } from "./scope";

interface Skill {
  id: string; name: string; description: string; icon: string;
  body: string; path: string; content: string;
}

/** VM-owned discovery. This never consults the desktop's home or Local engine. */
export async function listWorkspaceSkills(scope: WorkspaceScope, agentId: unknown): Promise<{ skills: Skill[] }> {
  if (agentId == null) return { skills: [] };
  if (agentId !== "claude" && agentId !== "codex" && agentId !== "cursor")
    throw new WorkspaceError("VALIDATION_FAILED", "Invalid skill provider.");
  const home = homedir();
  const providerHome = agentId === "codex" && process.env.CODEX_HOME
    ? process.env.CODEX_HOME : join(home, `.${agentId}`);
  const roots = [
    { owner: scope.root, path: join(scope.root, `.${agentId}`, "skills") },
    { owner: scope.root, path: join(scope.root, ".agents", "skills") },
    { owner: scope.root, path: join(scope.root, "skills") },
    { owner: providerHome, path: join(providerHome, "skills") },
    ...(agentId === "codex" ? [{ owner: providerHome, path: join(providerHome, "skills", ".system") }] : []),
    { owner: home, path: join(home, ".agents", "skills") },
  ];
  const byName = new Map<string, Skill>();
  let bytes = 14; // Object/array punctuation belongs to the wire budget too.
  for (const root of roots) {
    // The same held-descriptor checks as workspace reads, narrowed to each
    // known library's owner. Repositories cannot symlink into VM credentials.
    const owner = new CheckedFiles(new WorkspaceScope({ ...scope.workspace, checkoutPath: root.owner }));
    const directory = await owner.directory(root.path).catch(() => null);
    if (!directory) continue;
    try {
    const library = await realpath(descriptorPath(directory));
    const files = new CheckedFiles(new WorkspaceScope({ ...scope.workspace, checkoutPath: library }));
    const entries = await readdir(descriptorPath(directory), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries.slice(0, 512)) {
      if (byName.size >= 256) break;
      const id = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, "");
      const path = entry.isDirectory() ? join(library, entry.name, "SKILL.md")
        : entry.isFile() && /\.md$/i.test(entry.name) ? join(library, entry.name) : null;
      if (!path) continue;
      const handle = await files.file(path).catch(() => null);
      if (!handle) continue;
      try {
        const stat = await handle.stat();
        if (stat.size > 256 * 1024) continue;
        const buffer = Buffer.alloc(256 * 1024 + 1);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        await files.assertDescriptor(handle);
        await owner.assertDescriptor(directory);
        if (read.bytesRead > 256 * 1024) continue;
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, read.bytesRead));
        const frontmatter = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const field = (key: string) => frontmatter?.[1].match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1].trim().replace(/^(['"])(.*)\1$/, "$2");
        const name = field("name") || id;
        if (byName.has(name)) continue;
        const skill: Skill = { id, name, description: field("description") || "", icon: field("icon") || "FileText", path, content, body: frontmatter ? content.slice(frontmatter[0].length) : content };
        const size = Buffer.byteLength(JSON.stringify(skill)) + 1;
        if (bytes + size > 2 * 1024 * 1024) continue;
        bytes += size;
        byName.set(name, skill);
      } catch { /* An unreadable or changing skill does not expose a source. */ }
      finally { await handle.close(); }
    }
    } catch { /* A missing or replaced library is retried on next discovery. */ }
    finally { await directory.close(); }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
