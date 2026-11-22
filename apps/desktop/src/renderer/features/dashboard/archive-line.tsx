// An archived cloud workspace's retention line in a one-line row: whole sentences only. A sentence that doesn't
// fit wraps onto a second line the row hides, so no date or clause is ever cut mid-way; the full line is on hover.
import { cn } from "../../shared/ui/cn";

/** Sentences, each kept whole: "Backup kept until Jan 19, 2027." never loses its year. */
export function archiveLineUnits(line: string): string[] {
  return line.split(/(?<=\.)\s+(?=[A-Z])/);
}

export function ArchiveLineUnits({ line, className }: { line: string; className: string }) {
  return (
    <span title={line} data-archive-line="" className={cn("flex min-w-0 flex-wrap gap-x-1 overflow-hidden", className)}>
      {archiveLineUnits(line).map((unit, index) => (
        // The first sentence may shorten (its row is narrower than it); every later one shows whole or not at all.
        <span key={index} data-archive-unit="" className={index === 0 ? "max-w-full min-w-0 truncate" : "whitespace-nowrap"}>{unit}</span>
      ))}
    </span>
  );
}
