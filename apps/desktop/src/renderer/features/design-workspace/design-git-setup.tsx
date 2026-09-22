import { useRef, useState } from "react";
import { Folder } from "lucide-react";
import { gitInitInPlace, isGitErrorShape } from "../../platform/git";
import {
  loadProjects,
  upsertProject,
  type Project,
} from "../../state/projects-store";
import { notifyProjectsChanged } from "../../state/use-projects";
import { triggerGitRefresh } from "../../shell/use-git-refresh-key";
import { Button } from "../../shared/ui/primitives/button";
import { errorMessage } from "./design-workspace-error";

/** Git setup is explicit. Opening Design never initializes or publishes a folder. */
export function DesignGitSetup({
  project,
  active,
}: {
  project: Project;
  active: boolean;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const initialize = async () => {
    if (!active || pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await gitInitInPlace(project.repoRoot);
      // Completing a request for a removed owner must not re-add its folder.
      if (
        loadProjects().some(
          (row) => row.id === project.id && row.repoRoot === project.repoRoot,
        )
      ) {
        upsertProject({ repoRoot: project.repoRoot, isGitRepository: true });
        notifyProjectsChanged();
        triggerGitRefresh(project.repoRoot);
      }
    } catch (error) {
      setFailure(isGitErrorShape(error) ? error.message : errorMessage(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      data-design-tab-empty=""
    >
      <Folder className="text-muted-fg size-10" strokeWidth={1} aria-hidden />
      <Button
        variant="secondary"
        size="sm"
        disabled={!active || busy}
        onClick={() => void initialize()}
      >
        {busy ? "Initializing…" : "Initialize Git"}
      </Button>
      <p className="text-fg2 max-w-sm text-xs">
        Initialize Git to create a workspace for Design.
      </p>
      {failure && (
        <p
          role="alert"
          className="bg-red-bg text-red-fg max-w-sm rounded-md px-3 py-2 text-xs"
        >
          {failure}
        </p>
      )}
    </div>
  );
}
