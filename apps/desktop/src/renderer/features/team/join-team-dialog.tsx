// ──────────────────────────────────────────────────────────
// Join team — the modal a zeros://invite deep link lands in.
//
// Rendered once at the settings-page level so it works in EVERY team
// state — crucially for a zero-team user (the Administration tabs are
// hidden then, so there'd be no panel to host the join box). Also
// reachable from the create dialog's "Have an invite link?".
//
// Accepts a full invite link or a bare token (parseInviteToken). On
// success: store refresh → active-team switch → engine resync → the
// caller navigates to the Team tab (the tabs now exist).
// ──────────────────────────────────────────────────────────

import React, { useEffect, useState } from "react";
import { Button, Input } from "../../shared/ui";
import { toast } from "../../shared/ui/primitives/elements";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { controlPlane } from "./control-plane";
import { parseInviteToken } from "./invite-link";
import { setActiveOrganizationSelection } from "./active-team";
import { requestTeamResync } from "./team-sync";
import { refreshTeams } from "./team-store";
import { errorMessage } from "./team-panel";

export function JoinTeamDialog({
  open,
  initialToken,
  onOpenChange,
  onJoined,
}: {
  open: boolean;
  /** Pre-filled from a deep link; empty string = manual entry. */
  initialToken: string;
  onOpenChange: (open: boolean) => void;
  /** Fires AFTER the store refresh — safe to navigate to the team tabs. */
  onJoined?: () => void;
}) {
  const [draft, setDraft] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each open (or a newer deep link while already open) re-seeds the field.
  useEffect(() => {
    if (open) {
      setDraft(initialToken);
      setError(null);
      setBusy(false);
    }
  }, [open, initialToken]);

  const token = parseInviteToken(draft);

  const join = async () => {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { team } = await controlPlane.acceptInvitation(token);
      await refreshTeams();
      setActiveOrganizationSelection(team.id, false);
      requestTeamResync();
      onOpenChange(false);
      toast.success(`Welcome to ${team.name}`);
      onJoined?.();
    } catch (err) {
      // wrong_account / invalid_invite come back with exact, safe copy
      // (masked email; no existence oracle) — show inline, not a toast.
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Join team</DialogTitle>
          <DialogDescription>
            You've been invited to join a team on Zeros.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Input
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder="https://app.zeros.build/invite?token=…"
            aria-label="Invite link or code"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") void join();
            }}
          />
          {draft.trim() && !token && (
            <p className="text-fg2 text-xs">
              That doesn't look like an invite link or code.
            </p>
          )}
          {error && <p className="text-red-primary text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!token || busy} onClick={() => void join()}>
            {busy ? "Joining…" : "Join"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
