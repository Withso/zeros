import path from "node:path";

import type { DesignLintViolation } from "./document";

const MAX_AUDITS = 256;
const MAX_WARNINGS_PER_AUDIT = 128;
const RUNTIME_RULE_IDS = new Set(["contrast", "overflow", "spacing-scale"]);

interface DesignRuntimeAuditInput {
  workspacePath: string;
  frame: string;
  sourceVersion: string;
  warnings: readonly DesignLintViolation[];
}

interface DesignRuntimeAuditEntry extends DesignRuntimeAuditInput {
  warnings: readonly DesignLintViolation[];
}

const audits = new Map<string, DesignRuntimeAuditEntry>();

function auditKey(workspacePath: string, frame: string): string {
  return `${path.resolve(workspacePath)}\u0000${frame}`;
}

export function setDesignRuntimeAudit(input: DesignRuntimeAuditInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i.test(input.frame)) {
    throw new Error(`Invalid design frame file: ${input.frame}`);
  }
  if (!/^[a-f0-9]{24}$/.test(input.sourceVersion)) {
    throw new Error("Design runtime audit sourceVersion is invalid.");
  }
  if (input.warnings.length > MAX_WARNINGS_PER_AUDIT) {
    throw new Error("Design runtime audit contains too many warnings.");
  }
  const warnings = input.warnings.map((warning) => {
    if (
      warning.severity !== "warning" ||
      !RUNTIME_RULE_IDS.has(warning.ruleId) ||
      warning.file !== input.frame ||
      warning.message.length > 1_000 ||
      (warning.fix?.length ?? 0) > 1_000
    ) {
      throw new Error("Design runtime audit contains an invalid warning.");
    }
    return Object.freeze({ ...warning });
  });
  const key = auditKey(input.workspacePath, input.frame);
  audits.delete(key);
  audits.set(key, {
    ...input,
    workspacePath: path.resolve(input.workspacePath),
    warnings: Object.freeze(warnings),
  });
  while (audits.size > MAX_AUDITS) {
    const oldest = audits.keys().next().value as string | undefined;
    if (!oldest) break;
    audits.delete(oldest);
  }
}

export function getDesignRuntimeAudit(
  workspacePath: string,
  frame: string,
  sourceVersion: string,
): readonly DesignLintViolation[] {
  const key = auditKey(workspacePath, frame);
  const audit = audits.get(key);
  if (!audit) return [];
  if (audit.sourceVersion !== sourceVersion) {
    audits.delete(key);
    return [];
  }
  audits.delete(key);
  audits.set(key, audit);
  return audit.warnings;
}

export function forgetDesignRuntimeAudits(workspacePath: string): void {
  const prefix = `${path.resolve(workspacePath)}\u0000`;
  for (const key of audits.keys()) {
    if (key.startsWith(prefix)) audits.delete(key);
  }
}

export function resetDesignRuntimeAuditsForTests(): void {
  audits.clear();
}
