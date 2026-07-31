// ============================================
// COMPONENT: DesignChangeCard
// PURPOSE: Turn-authored design files and deterministic lint feedback
// USED IN: TurnFooter for settled design-mode turns
// ============================================

// --- IMPORTS ---

import { AlertTriangle, Check, FileCode2 } from "lucide-react";

import type { DesignLintReportWire } from "../../native/git";
import type { TurnFile } from "../../native/turns";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "../ui/primitives";
import {
  groupDesignLintViolations,
  lintReviewBadgeLabel,
} from "./design-lint-summary";

// --- TYPES ---

interface DesignChangeCardProps {
  /** Disk-authoritative files attributed to exactly this agent turn. */
  files: readonly TurnFile[];
  /** Latest exact-workspace lint report, shared with canvas and inspector. */
  lint?: DesignLintReportWire | null;
}

// --- WORKFLOWS ---

export function designTurnFiles(files: readonly TurnFile[]): TurnFile[] {
  return files.filter((file) => file.path.startsWith("Zeros Design/"));
}

function operationLabel(file: TurnFile): string {
  switch (file.status) {
    case "added":
      return "Created";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    default:
      return "Updated";
  }
}

// --- RENDER ---

export function DesignChangeCard({
  files,
  lint = null,
}: DesignChangeCardProps) {
  const designFiles = designTurnFiles(files);
  if (designFiles.length === 0) return null;
  const frameCount = designFiles.filter((file) =>
    file.path.toLowerCase().endsWith(".html"),
  ).length;
  const violations = lint?.violations ?? [];
  const errors = violations.filter(
    (violation) => violation.severity === "error",
  );
  const warnings = violations.filter(
    (violation) => violation.severity === "warning",
  );
  const warningGroups = groupDesignLintViolations(warnings);

  return (
    <Card className="mt-2">
      <CardContent className="flex flex-col gap-3 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>
              {frameCount > 0
                ? `Updated ${frameCount} ${frameCount === 1 ? "frame" : "frames"}`
                : "Updated design styles"}
            </CardTitle>
            <CardDescription>
              Authored files from this agent turn
            </CardDescription>
          </div>
          {lint ? (
            <Badge
              variant={
                errors.length > 0
                  ? "failure"
                  : warnings.length > 0
                    ? "secondary"
                    : "success"
              }
            >
              {errors.length > 0 ? (
                <>
                  <AlertTriangle className="size-3" />
                  {errors.length} {errors.length === 1 ? "error" : "errors"}
                </>
              ) : warnings.length > 0 ? (
                <>
                  <AlertTriangle className="size-3" />
                  {lintReviewBadgeLabel(warningGroups)}
                </>
              ) : (
                <>
                  <Check className="size-3" />
                  Lint clean
                </>
              )}
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          {designFiles.map((file) => (
            <div
              key={`${file.status}:${file.path}`}
              className="text-fg2 flex min-w-0 items-center gap-2 text-xs"
            >
              <FileCode2 className="size-3.5 shrink-0" />
              <span className="text-fg3 shrink-0">{operationLabel(file)}</span>
              <span className="min-w-0 truncate">{file.path}</span>
            </div>
          ))}
        </div>

        {warnings.length > 0 && errors.length === 0 ? (
          <div className="border-border1 text-fg2 flex flex-col gap-1 border-t pt-2 text-xs">
            <span>
              {warnings.length} non-blocking design{" "}
              {warnings.length === 1 ? "finding" : "findings"}
            </span>
            {warningGroups.slice(0, 3).map((group) => (
              <span key={group.ruleId}>
                {group.label} · {group.count}{" "}
                {group.count === 1 ? "finding" : "findings"}
              </span>
            ))}
            {warningGroups.length > 3 ? (
              <span>+{warningGroups.length - 3} more review rules</span>
            ) : null}
          </div>
        ) : null}

        {errors.length > 0 ? (
          <div className="border-border1 text-red-primary flex flex-col gap-1 border-t pt-2 text-xs">
            {errors.slice(0, 3).map((violation) => (
              <span
                key={`${violation.ruleId}:${violation.file}:${violation.line}:${violation.column}`}
              >
                {violation.ruleId} · {violation.file}:{violation.line} —{" "}
                {violation.message}
              </span>
            ))}
            {errors.length > 3 ? (
              <span>+{errors.length - 3} more lint errors</span>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
