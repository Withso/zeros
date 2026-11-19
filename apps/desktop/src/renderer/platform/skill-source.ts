import { loadSkillCatalog } from "./skill-catalog";
import type { ReadFileResult } from "./files";

export interface SkillSource {
  agentId: "claude" | "codex" | "cursor";
  path: string;
  name: string;
}

export function validSkillSource(value: unknown): value is SkillSource {
  if (!value || typeof value !== "object") return false;
  const source = value as SkillSource;
  return ["claude", "codex", "cursor"].includes(source.agentId) &&
    typeof source.path === "string" && source.path.length > 0 && source.path.length <= 4096 && !source.path.includes("\0") &&
    typeof source.name === "string" && source.name.length > 0 && source.name.length <= 512;
}

export async function readSkillSource(cwd: string, source: SkillSource): Promise<ReadFileResult> {
  if (!validSkillSource(source)) throw new Error("Invalid skill source.");
  // A persisted or pasted reference grants no file access; resolve it only through the captured workspace/provider catalog.
  const skill = (await loadSkillCatalog(cwd, source.agentId)).find(skill => skill.path === source.path);
  if (!skill || typeof skill.content !== "string") throw new Error("This skill source is no longer available.");
  return { kind: "text", path: source.path, content: skill.content, bytes: new TextEncoder().encode(skill.content).length };
}
