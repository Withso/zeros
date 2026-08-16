// ──────────────────────────────────────────────────────────
// Design-mode-disabled placeholder
// ──────────────────────────────────────────────────────────
//
// Rendered in place of the workspace body when the ACTIVE workspace is in
// design mode but the `designWorkspaces` Internal feature is off (or the
// staff role was revoked between launches). Under the mode model this is a
// perfectly good workspace — the same worktree, one click from being a code
// workspace again — so hiding it or bouncing to Home would trap it in a mode
// whose surface can't render. Exiting design mode is therefore NEVER gated on
// the flag: the one action this panel offers flips the row back to code and
// the ordinary coding harness mounts in its place.
//
// The coding harness itself must not mount as a fallback while the row still
// says "design": the engine refuses agents/terminals for design-mode
// workspaces, so that shell would be a field of dead controls.
// ──────────────────────────────────────────────────────────

import React, { useState } from "react";
import { Code2, PenTool } from "lucide-react";

import { Button } from "../shared/ui";
import { toast } from "../shared/ui/primitives/elements";
import { workspaceSetMode, type Workspace } from "../platform/git";
import { notifyWorkspacesChanged } from "../state/use-projects";

export function DesignModeDisabledPanel({
  workspace,
}: {
  workspace: Workspace;
}) {
  const [switching, setSwitching] = useState(false);

  const handleExit = async () => {
    if (switching) return;
    setSwitching(true);
    try {
      await workspaceSetMode({ workspaceId: workspace.id, mode: "code" });
      // The row flip re-renders this route into the coding harness.
      notifyWorkspacesChanged(workspace.repoSlug);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't switch to code mode",
      );
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="bg-bg1 flex h-full w-full items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <div className="bg-bg2 flex size-12 items-center justify-center rounded-sm">
          <PenTool className="text-fg2 size-6" strokeWidth={1} aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-fg1 text-sm font-medium">
            This workspace is in design mode
          </h3>
          <p className="text-fg2 text-xs">
            Design mode is an Internal feature and it&rsquo;s currently off, so
            the design canvas can&rsquo;t open here. Switch the workspace back
            to code mode to keep working — nothing in it is lost.
          </p>
        </div>
        <Button
          variant="secondary"
          size="md"
          onClick={() => void handleExit()}
          disabled={switching}
        >
          <Code2 className="size-4" aria-hidden="true" />
          {switching ? "Switching…" : "Switch to Code Mode"}
        </Button>
      </div>
    </div>
  );
}
