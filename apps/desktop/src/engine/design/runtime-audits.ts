import path from "node:path";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";
import { isDesignFrameFile } from "@zeros/protocol/design-path";
import { designDirectoryNameFor } from "./directory-registry";
import { designPagesMigrationGeneration } from "./pages-migration";

import type { DesignLintViolation } from "./document";

/** Every frame of a full page keeps its audit; the warning total holds
 * retained memory to the earlier bound of 256 full audits. */
const MAX_AUDITS = DESIGN_MAX_FRAMES_PER_PAGE;
const MAX_WARNINGS_PER_AUDIT = 128;
const MAX_RETAINED_WARNINGS = 256 * MAX_WARNINGS_PER_AUDIT;
const RUNTIME_RULE_IDS = new Set([
  "contrast",
  "overflow",
  "spacing-scale",
  "audit-limit",
  "layer-tree-limit",
]);

interface DesignRuntimeAuditInput {
  workspacePath: string;
  frame: string;
  sourceVersion: string;
  warnings: readonly DesignLintViolation[];
}

interface DesignRuntimeAuditEntry extends DesignRuntimeAuditInput {
  warnings: readonly DesignLintViolation[];
  directory: string;
  migrationGeneration: string | null;
}

const audits = new Map<string, DesignRuntimeAuditEntry>();
let retainedWarnings = 0;

function forgetAudit(key: string): void {
  const audit = audits.get(key);
  if (!audit) return;
  audits.delete(key);
  retainedWarnings -= audit.warnings.length;
}

function auditKey(workspacePath: string, frame: string): string {
  return `${path.resolve(workspacePath)}\u0000${frame}`;
}

export function setDesignRuntimeAudit(input: DesignRuntimeAuditInput): void {
  if (!isDesignFrameFile(input.frame)) {
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
  const directory = designDirectoryNameFor(input.workspacePath);
  forgetAudit(key);
  audits.set(key, {
    ...input,
    workspacePath: path.resolve(input.workspacePath),
    warnings: Object.freeze(warnings),
    directory,
    migrationGeneration: designPagesMigrationGeneration(input.workspacePath, directory),
  });
  retainedWarnings += warnings.length;
  while (audits.size > MAX_AUDITS || retainedWarnings > MAX_RETAINED_WARNINGS) {
    const oldest = audits.keys().next().value as string | undefined;
    if (!oldest) break;
    forgetAudit(oldest);
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
  if (audit.sourceVersion !== sourceVersion ||
      audit.migrationGeneration !== designPagesMigrationGeneration(workspacePath, audit.directory)) {
    forgetAudit(key);
    return [];
  }
  audits.delete(key);
  audits.set(key, audit);
  return audit.warnings;
}

export function forgetDesignRuntimeAudits(workspacePath: string): void {
  const prefix = `${path.resolve(workspacePath)}\u0000`;
  for (const key of [...audits.keys()]) {
    if (key.startsWith(prefix)) forgetAudit(key);
  }
}

export function resetDesignRuntimeAuditsForTests(): void {
  audits.clear();
  retainedWarnings = 0;
}
