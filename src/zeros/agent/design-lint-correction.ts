import type {
  DesignLintReportWire,
  DesignLintViolationWire,
} from "../../native/git";

const MAX_AUTOMATIC_CORRECTIONS_PER_BROKEN_STREAK = 1;

/** A clean lint pass resets this count; a still-broken correction never loops. */
export function designLintCorrectionBudgetAllows(count: number): boolean {
  return count < MAX_AUTOMATIC_CORRECTIONS_PER_BROKEN_STREAK;
}

export function designLintErrors(
  report: DesignLintReportWire,
): DesignLintViolationWire[] {
  return report.violations.filter(
    (violation) => violation.severity === "error",
  );
}

/** Stable across harmless engine ordering changes, preventing correction loops. */
export function designLintCorrectionSignature(
  report: DesignLintReportWire,
): string | null {
  const errors = designLintErrors(report);
  if (errors.length === 0) return null;
  return errors
    .map((violation) =>
      [
        violation.ruleId,
        violation.file,
        violation.line,
        violation.column,
        violation.message,
      ].join("\u0000"),
    )
    .sort()
    .join("\u0001");
}

/** Concrete deterministic follow-up; judgment remains with the design agent. */
export function designLintCorrectionPrompt(
  report: DesignLintReportWire,
): string {
  const lines = designLintErrors(report).map((violation) => {
    const fix = violation.fix ? ` Suggested fix: ${violation.fix}` : "";
    return `- [${violation.ruleId}] ${violation.file}:${violation.line}:${violation.column} — ${violation.message}${fix}`;
  });
  return [
    "A deterministic design lint pass found errors after your last turn.",
    "Correct them now in Zeros Design, preserve the requested visual intent, and run lint_design before you finish.",
    "Do not add JavaScript and do not edit .zeros-canvas.json.",
    "",
    ...lines,
  ].join("\n");
}
