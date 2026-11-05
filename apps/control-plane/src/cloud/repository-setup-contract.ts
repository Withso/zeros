import { z } from "zod";

const PRIVATE_SEGMENTS = new Set([".git", ".zeros", ".context", ".context-graph", ".appdata", ".conductor", ".claude", ".codex", ".cursor", ".ssh"]);

export function isRepositorySetupPath(value: string): boolean {
  if (!value || value.length > 512 || value !== value.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u.test(value) || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== ".." &&
    !PRIVATE_SEGMENTS.has(part.toLowerCase()) && !/^\.env(?:\.|$)/i.test(part));
}

export const RepositorySetupPathSchema = z.string().max(512).refine(isRepositorySetupPath, "Choose a tracked script within the repository.");
