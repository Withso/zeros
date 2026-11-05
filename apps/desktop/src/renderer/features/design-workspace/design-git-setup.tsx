import { useRef, useState } from "react";
import { FolderGit2 } from "lucide-react";
import { gitInitInPlace, isGitErrorShape } from "../../platform/git";
import {
  loadProjects,
  upsertProject,
  type Project,
} from "../../state/projects-store";
import { notifyProjectsChanged } from "../../state/use-projects";
import { triggerGitRefresh } from "../../shell/use-git-refresh-key";
import { Button } from "../../shared/ui/primitives/button";
import { EmptyState } from "../../shared/ui/layout/empty-state";
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
  // The empty-state recipe: a failure is one red line under the text and the
  // button stays ready to try again.
  return (
    <EmptyState
      icon={FolderGit2}
      title="Design needs Git"
      data-design-tab-empty=""
      error={failure ? `Couldn’t initialize Git: ${failure}` : null}
      action={
        <Button
          variant="primary"
          disabled={!active || busy}
          loading={busy}
          onClick={() => void initialize()}
        >
          {busy ? "Initializing…" : "Initialize Git"}
        </Button>
      }
    >
      Initialize Git in this folder to start designing.
    </EmptyState>
  );
}
