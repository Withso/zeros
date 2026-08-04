import type { DesignLintViolationWire } from "../../native/git";

export interface DesignLintViolationGroup {
  ruleId: DesignLintViolationWire["ruleId"];
  label: string;
  count: number;
  first: DesignLintViolationWire;
}

const RULE_LABELS: Record<DesignLintViolationWire["ruleId"], string> = {
  "component-invalid": "Component definition",
  "component-undefined": "Missing component",
  contrast: "Text contrast",
  "frames-are-valid-html": "HTML structure",
  "local-refs-only": "Local references",
  "no-event-handlers": "Event handlers",
  "no-external-url": "External resources",
  "no-script": "Scripts",
  "oid-duplicate": "Duplicate layer ids",
  "oid-missing": "Missing layer ids",
  overflow: "Layout overflow",
  "spacing-scale": "Spacing scale",
  "unknown-token": "Unknown tokens",
};

/** Runtime audits intentionally report one finding per affected layer. Group
 * those exact findings for presentation so a repeated rule reads as one
 * review area without discarding the underlying count or locations. */
export function groupDesignLintViolations(
  violations: readonly DesignLintViolationWire[],
): DesignLintViolationGroup[] {
  const groups = new Map<
    DesignLintViolationWire["ruleId"],
    DesignLintViolationGroup
  >();
  for (const violation of violations) {
    const current = groups.get(violation.ruleId);
    if (current) {
      current.count += 1;
      continue;
    }
    groups.set(violation.ruleId, {
      ruleId: violation.ruleId,
      label: RULE_LABELS[violation.ruleId],
      count: 1,
      first: violation,
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.count - left.count || left.label.localeCompare(right.label),
  );
}

export function lintReviewBadgeLabel(
  groups: readonly DesignLintViolationGroup[],
): string {
  return `Review ${groups.length} ${groups.length === 1 ? "rule" : "rules"}`;
}

/** Name the first exact blocking location in compact button/alert copy. */
export function blockingDesignLintReason(
  violation: DesignLintViolationWire,
): string {
  return `${violation.file}:${violation.line} · ${violation.ruleId}`;
}
