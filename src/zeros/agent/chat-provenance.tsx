// The empty chat's provenance block — what this workspace IS, shown where the
// transcript will be.
//
// Replaces the old "Session ready. Ask the agent anything." line (2026-07-29
// user spec). That string had two problems: it said nothing (a ready session is
// the unremarkable case), and because it was gated on `session.status ===
// "ready"` it blinked out and back every time the session respawned — which,
// before the fix in column2-chat-view.tsx, was on every model/effort/Fast pill
// click.
//
// The replacement is deliberately about the WORKSPACE, not the session, so it
// is stable across session churn:
//
//   📁  Created  [Bone]                        ← chip opens the Open in… menu
//   ⑂   Branched jordan/Bone from origin/main
//   >_  Completed setup script                 ← 3 states, see SetupRow
//
// Rows render as they resolve rather than waiting on the slowest one — the
// workspace row comes from the already-loaded store, while the setup state is
// a bridge read. A row whose data isn't known yet is omitted, never skeletoned:
// this block sits above the composer on a chat the user is about to type into,
// so a placeholder would be more distracting than the missing line.
//
// Chats with a transcript get a different treatment (per-chat summaries) — not
// this block. See the caller's gate in agent-chat.tsx.

import { useMemo } from "react";
import { FolderClosed, GitBranch, Terminal } from "lucide-react";

import { OpenInBadgeMenu } from "@/shell/column2-topbar";
import { useOpenScriptsSettings } from "@/shell/column3-tabs/setup-tab";
import { workspaceLabel } from "@/shell/top-bar-helpers";
import { ZerosSpinner } from "@/zeros/ui/primitives";
import { isLocalMainWorkspace } from "../store/local-main-workspace";
import { useProjectForFolder, useWorkspacesFor } from "../store/use-projects";
import { findWorkspaceForFolder } from "../store/workspace-resolution";
import {
  useWorkspaceSetupSummary,
  type WorkspaceSetupSummary,
} from "./use-workspace-setup-summary";
import type { Workspace } from "../../native/git";

/** One provenance line. The icon column is fixed-width so the three rows'
 *  text baselines align regardless of glyph width.
 *
 *  ONE type treatment for the whole block (2026-07-29 founder direction): every
 *  string is `text-sm` (14px in this app — see zeros-tokens.css §text scale)
 *  in `--fg2`, in the UI font. Nothing here is emphasised and nothing is mono:
 *  an earlier pass set the refs in `--fg1` mono to mark them as literals, which
 *  made three short lines read as three different kinds of content. */
function Row({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="text-fg2 flex items-center gap-2 text-sm">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

/** "Branched <branch> from <base>".
 *
 *  Plain spans, deliberately NOT a `code` element: the UA stylesheet gives that
 *  tag a monospace family, and this block is single-font (see Row). The refs
 *  are still exact strings a `git checkout` would need — they just don't
 *  announce it typographically. */
function BranchedRow({ workspace }: { workspace: Workspace }) {
  // The trunk / "main" was never branched from anything — it IS the base. Its
  // synthetic row carries the repo's own branch, so the sentence would read
  // "Branched main from main".
  if (isLocalMainWorkspace(workspace)) return null;
  const base = workspace.baseBranch?.trim();
  if (!workspace.branch || !base) return null;
  return (
    <Row icon={<GitBranch className="size-3.5" aria-hidden="true" />}>
      <span className="shrink-0">Branched</span>
      <span className="truncate">{workspace.branch}</span>
      <span className="shrink-0">from</span>
      <span className="truncate">{base}</span>
    </Row>
  );
}

/** Which of the setup row's three shapes to draw, or "unknown" for "say
 *  nothing yet".
 *
 *  Split out as a pure function because the mapping carries two judgement
 *  calls that are easy to regress and worth pinning in a test:
 *
 *    • `hasCommand === null` (the read hasn't landed) must NOT collapse into
 *      the not-configured case, or every chat flashes "Configure setup script"
 *      before correcting itself.
 *    • "completed" covers passed / failed / stopped alike. This row reports
 *      that the create-time step is BEHIND you, not whether the command exited
 *      0 — the Setup tab owns pass/fail, with the log to explain it. Putting a
 *      red failure here would raise an alarm on a surface the user came to
 *      type in, and one they can't act on from here. */
export type SetupRowState =
  | "unknown"
  | "not-configured"
  | "running"
  | "completed";

export function setupRowState(summary: WorkspaceSetupSummary): SetupRowState {
  if (summary.hasCommand === null) return "unknown";
  if (!summary.hasCommand) return "not-configured";
  return summary.state === "running" ? "running" : "completed";
}

function SetupRow({ workspace }: { workspace: Workspace }) {
  const openScripts = useOpenScriptsSettings();
  const summary = useWorkspaceSetupSummary(
    workspace.id,
    // Only the trunk needs the explicit repoRoot fallback — a real worktree
    // resolves its command from its own row.
    isLocalMainWorkspace(workspace) ? workspace.repoRoot : undefined,
  );

  switch (setupRowState(summary)) {
    case "unknown":
      return null;
    case "not-configured":
      return (
        <Row icon={<Terminal className="size-3.5" aria-hidden="true" />}>
          <button
            type="button"
            onClick={openScripts}
            // Colour-only hover (2026-07-29 founder direction). An underline
            // here fought the block's flatness for no information gain — the
            // pointer cursor already says "clickable", and this is the only
            // interactive text in three rows so there is nothing to
            // disambiguate it from.
            className="hover:text-fg1 cursor-pointer transition-colors"
          >
            Configure setup script
          </button>
        </Row>
      );
    case "running":
      return (
        <Row icon={<ZerosSpinner size={14} />}>
          <span>Setup script is running</span>
        </Row>
      );
    case "completed":
      return (
        <Row icon={<Terminal className="size-3.5" aria-hidden="true" />}>
          <span>Completed setup script</span>
        </Row>
      );
  }
}

/** Resolve the chat's folder to its workspace and render the block. Renders
 *  nothing at all when the folder isn't a known workspace (a plain bound
 *  directory, or a workspace the store hasn't loaded yet) — there is no
 *  provenance to state, and an empty transcript with an empty header is the
 *  correct "nothing to say" outcome.
 *
 *  `children` is the transcript pill row (chat-transcript-pills.tsx), passed
 *  as a slot so this file keeps no dependency on the composer. It rides INSIDE
 *  the container on purpose: it inherits the gap-3 row rhythm rather than
 *  re-declaring it, and it inherits the `null` above — a folder with no
 *  provenance to state has no transcripts worth offering either. */
export function ChatProvenance({
  folder,
  children,
}: {
  folder: string | undefined;
  children?: React.ReactNode;
}) {
  const project = useProjectForFolder(folder ?? null);
  const { workspaces } = useWorkspacesFor(project?.repoSlug ?? null);
  // Memoized like the topbar's identical lookup: this renders inside the chat
  // transcript, which re-renders on every streamed token, and the scan would
  // otherwise walk the workspace list each time.
  const workspace = useMemo(
    () => findWorkspaceForFolder(folder ?? null, workspaces),
    [folder, workspaces],
  );

  if (!workspace) return null;

  return (
    // gap-3 = 12px between rows (2026-07-29 founder direction). At 14px text
    // the previous 8px packed the three lines into a single visual mass.
    <div className="flex flex-col gap-3 p-3">
      <Row icon={<FolderClosed className="size-3.5" aria-hidden="true" />}>
        <span className="shrink-0">Created</span>
        <OpenInBadgeMenu
          path={workspace.path}
          label={workspaceLabel(workspace)}
        />
      </Row>
      <BranchedRow workspace={workspace} />
      <SetupRow workspace={workspace} />
      {children}
    </div>
  );
}
