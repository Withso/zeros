/** The immutable image helper communicates success/failure as structured data;
 * arbitrary command output is never part of that protocol. Keep this boundary
 * fail-closed if a provider or future helper nevertheless supplies text. */
export function sanitizeCloudWorkspaceSetupLog(value: string): string {
  return value.length > 0 ? "[cloud workspace setup output withheld]" : "";
}

export type CloudWorkspaceSetupHookLog = { version: 1; text: string; truncated: boolean };

/** Accepted only from the pinned v4 helper's structured error envelope. That
 * helper redacts execution literals before transport. Arbitrary provider text
 * still passes through the withholding boundary above. */
export function parseCloudWorkspaceSetupHookLog(value: unknown): CloudWorkspaceSetupHookLog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const log = value as Record<string, unknown>;
  if (Object.keys(log).sort().join() !== "text,truncated,version" || log.version !== 1 || typeof log.text !== "string" ||
      Buffer.byteLength(log.text) > 16 * 1024 || /[\x00-\x08\x0b-\x1f\x7f]/.test(log.text) || typeof log.truncated !== "boolean") return null;
  return { version: 1, text: log.text.replace(/(?:gh[opsu]_)[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[^\s]+/gi, "[redacted]"), truncated: log.truncated };
}
