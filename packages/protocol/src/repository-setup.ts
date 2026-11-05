import { z } from "zod";

export const REPOSITORY_SETUP_MAX_BYTES = 64 * 1024;
const PRIVATE_SEGMENTS = new Set([".git", ".zeros", ".context", ".context-graph", ".appdata", ".conductor", ".claude", ".codex", ".cursor", ".ssh"]);

export function isRepositorySetupPath(value: string): boolean {
  if (!value || value.length > 512 || value !== value.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u.test(value) || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== ".." &&
    !PRIVATE_SEGMENTS.has(part.toLowerCase()) && !/^\.env(?:\.|$)/i.test(part));
}

export const RepositorySetupPathSchema = z.string().max(512).refine(isRepositorySetupPath, "Choose a tracked script within the repository.");

export type RepositorySetupSelection = { kind: "script"; path: string } | { kind: "command"; command: string };

export function selectRepositorySetup(input: { setupScript?: string; inlineCommand?: string }): RepositorySetupSelection | null {
  if (input.setupScript?.trim()) return { kind: "script", path: input.setupScript };
  if (input.inlineCommand?.trim()) return { kind: "command", command: input.inlineCommand.trim() };
  return null;
}

/** POSIX single-quote a path/string so it survives `sh -c "<cmd>"`. */
export function quoteSetupArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
