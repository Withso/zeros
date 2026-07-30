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
//
// 2026-07-30 founder direction: the three rows STEP ASIDE the moment this
// folder has even one prior chat to offer. They are not additive with the
// transcript row — see provenanceBlockShape.

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

/** What the empty state draws, from the one question that decides it: does this
 *  folder have a prior chat to offer?
 *
 *  2026-07-30 founder direction: when the answer is yes, "Add chat transcripts"
 *  is the WHOLE block — the three workspace rows are not shown alongside it.
 *  They describe a workspace the user just created and already knows about; the
 *  transcript row is the only line on this surface they can act on, and pairing
 *  the two buried it under three lines of trivia.
 *
 *  The third state is the load-bearing one, and it is the same call
 *  `setupRowState` makes for the setup read: `null` is "haven't looked yet",
 *  NOT "no transcripts". Collapsing it into the no-transcripts case would paint
 *  three rows on every new chat tab and then yank them a frame later, when the
 *  folder's chat list lands — a pop-out, which reads as a glitch in a way that
 *  content arriving late does not. So the block waits. Every chat that renders
 *  it has the read in flight (see the `transcriptRowLive` gate in
 *  agent-chat.tsx), and it is one local SQLite round trip.
 *
 *  "waiting" guards the FIRST answer, not every answer. In a split layout two
 *  panes on one folder are active at once, so sending the first message in
 *  pane 2 can flip pane 1 from "workspace" to "transcripts" live, unmounting
 *  three rows in front of the user. That is accepted: the new shape is the
 *  correct one, the alternative is latching a stale block for the life of the
 *  mount, and the founder's rule is about what is on screen — not about when
 *  it got there. */
export type ProvenanceBlockShape = "waiting" | "workspace" | "transcripts";

export function provenanceBlockShape(
  hasTranscripts: boolean | null,
): ProvenanceBlockShape {
  if (hasTranscripts === null) return "waiting";
  return hasTranscripts ? "transcripts" : "workspace";
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
  hasTranscripts,
  children,
}: {
  folder: string | undefined;
  /** Does this folder have a prior chat to offer? `null` until the read
   *  lands. Derived by the caller from the SAME summaries array the pill row
   *  renders, so the two cannot disagree about whether the row is there. */
  hasTranscripts: boolean | null;
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

  const shape = provenanceBlockShape(hasTranscripts);

  if (!workspace) return null;
  // "Haven't looked yet" — say nothing at all rather than commit to a shape
  // this frame and change it the next. See provenanceBlockShape.
  if (shape === "waiting") return null;

  return (
    // gap-3 = 12px between rows (2026-07-29 founder direction). At 14px text
    // the previous 8px packed the three lines into a single visual mass.
    <div className="flex flex-col gap-3 p-3">
      {/* Not rendered at all when a transcript row will take this block —
          unmounted rather than hidden, so SetupRow's bridge read never fires
          for a block nobody sees. */}
      {shape === "workspace" && (
        <>
          <Row icon={<FolderClosed className="size-3.5" aria-hidden="true" />}>
            <span className="shrink-0">Created</span>
            <OpenInBadgeMenu
              path={workspace.path}
              label={workspaceLabel(workspace)}
            />
          </Row>
          <BranchedRow workspace={workspace} />
          <SetupRow workspace={workspace} />
        </>
      )}
      {children}
    </div>
  );
}
