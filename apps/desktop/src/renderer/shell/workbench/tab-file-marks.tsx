import type { FileChangeStatus } from "../../platform/git";
import { cn } from "../../shared/ui/cn";
import { FILE_STATUS_PRESENTATION } from "./tabs/file-status";

/** A File tab's Git status letter and unsaved-changes dot, after its name.
 * Each keeps a hover title: a lone "M" means nothing until it says Modified,
 * as the file tree's letters do. */
export function TabFileMarks({
  fileStatus,
  dirty,
}: {
  fileStatus?: FileChangeStatus;
  dirty: boolean;
}) {
  const status = fileStatus ? FILE_STATUS_PRESENTATION[fileStatus] : undefined;
  return (
    <>
      {status && (
        <span role="img" aria-label={status.label} title={status.label} className={cn("text-3xxs leading-4 shrink-0 font-medium", status.className)}>
          {status.letter}
        </span>
      )}
      {dirty && (
        <span role="img" aria-label="Unsaved changes" title="Unsaved changes" className="bg-fg3 size-1.5 shrink-0 rounded-full" />
      )}
    </>
  );
}
