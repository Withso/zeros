// ──────────────────────────────────────────────────────────
// Create team — the modal behind the sidebar's "+ Create team" entry
// (zero-team state) and the team switcher's "New team" item.
//
// Name (required) · Logo (optional, downscaled client-side) · Invite
// members (optional, comma/newline emails). Creation is three steps the
// user sees as one: POST /v1/teams → per-email invitations → store
// refresh + active-team switch + engine resync. Invite failures never
// roll back the created team — they're reported and re-tryable from the
// Members tab.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { Button, Input, Textarea } from "../ui";
import { toast } from "../ui/primitives/elements";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import { controlPlane } from "../team/control-plane";
import { setActiveTeamId } from "../team/active-team";
import { requestTeamResync } from "../team/team-sync";
import { refreshTeams } from "../team/team-store";
import { TEAM_LOGO_ACCEPT, fileToTeamLogo } from "../team/team-logo";
import { MAX_INVITES_PER_BATCH, parseInviteEmails } from "../team/invite-emails";
import { errorMessage } from "./team-panel";

export function CreateTeamDialog({
  open,
  onOpenChange,
  onCreated,
  onSwitchToJoin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires AFTER the store refresh — the Administration tabs exist again,
   *  so the caller can navigate to the Team tab. */
  onCreated?: () => void;
  /** "Have an invite link?" — swap this dialog for the Join dialog. */
  onSwitchToJoin?: () => void;
}) {
  const [name, setName] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [invites, setInvites] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Fresh form per open (state survives closes because the dialog stays
  // mounted at the settings-page level).
  useEffect(() => {
    if (open) {
      setName("");
      setLogo(null);
      setInvites("");
      setBusy(false);
    }
  }, [open]);

  const parsed = parseInviteEmails(invites);
  const inviteProblem =
    parsed.invalid.length > 0
      ? `Not an email: ${parsed.invalid.slice(0, 3).join(", ")}${parsed.invalid.length > 3 ? "…" : ""}`
      : parsed.valid.length > MAX_INVITES_PER_BATCH
        ? `Up to ${MAX_INVITES_PER_BATCH} invitations at a time.`
        : null;
  const canCreate = !busy && name.trim().length > 0 && !inviteProblem;

  const pickLogo = async (file: File | null) => {
    if (!file) return;
    try {
      setLogo(await fileToTeamLogo(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that image");
    }
  };

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const { team } = await controlPlane.createTeam(name.trim(), logo);

      // Invitations are best-effort AFTER the team exists — a mail/limit
      // failure must not read as "creation failed".
      const failed: string[] = [];
      for (const email of parsed.valid) {
        try {
          await controlPlane.createInvitation(team.id, email, "member");
        } catch {
          failed.push(email);
        }
      }

      await refreshTeams();
      setActiveTeamId(team.id);
      requestTeamResync();
      onOpenChange(false);
      toast.success(`${team.name} created`);
      if (failed.length > 0) {
        toast.error(
          `Couldn't invite ${failed.join(", ")} — retry from the Members tab`,
        );
      }
      onCreated?.();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create team</DialogTitle>
          <DialogDescription>
            Pick a name. Invite people if needed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="new-team-name" className="text-fg1 text-sm font-medium">
              Team name
            </label>
            <div className="flex items-center gap-3">
              {/* Logo picker — a square the size of the resulting logo;
                  click to choose, click again to replace. */}
              <input
                ref={fileRef}
                type="file"
                accept={TEAM_LOGO_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  void pickLogo(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label={logo ? "Change logo" : "Add a logo (optional)"}
                title={logo ? "Change logo" : "Add a logo (optional)"}
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                className="border-border3 hover:border-border4 hover:bg-bg2 flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed outline-none"
              >
                {logo ? (
                  <img src={logo} alt="" className="size-full object-cover" draggable={false} />
                ) : (
                  <ImagePlus size={16} className="text-fg2" />
                )}
              </button>
              <Input
                id="new-team-name"
                autoFocus
                value={name}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Inc"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
            </div>
            {logo && (
              <button
                type="button"
                onClick={() => setLogo(null)}
                disabled={busy}
                className="text-fg2 hover:text-fg1 self-start text-xs"
              >
                Remove logo
              </button>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="new-team-invites" className="text-fg1 text-sm font-medium">
              Invite members <span className="text-fg2 font-normal">(optional)</span>
            </label>
            <Textarea
              id="new-team-invites"
              value={invites}
              disabled={busy}
              onChange={(e) => setInvites(e.target.value)}
              placeholder="email@company.com"
              spellCheck={false}
              rows={3}
            />
            <p className={inviteProblem ? "text-red-primary text-xs" : "text-fg2 text-xs"}>
              {inviteProblem ?? "Comma or newline separated."}
            </p>
          </div>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          {onSwitchToJoin ? (
            <button
              type="button"
              onClick={onSwitchToJoin}
              disabled={busy}
              className="text-fg2 hover:text-fg1 text-xs"
            >
              Have an invite link?
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!canCreate} onClick={() => void create()}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
