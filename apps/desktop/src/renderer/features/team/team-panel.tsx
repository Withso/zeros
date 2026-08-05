// ──────────────────────────────────────────────────────────
// Settings → Administration → Team
//
// The team's identity card (2026-07-22 revamp): logo, name, ID, your
// role — in the filled-card row style (SETTINGS_CARD_LIST_CLS, the
// Models-panel recipe) — plus a Danger zone (owner-only delete) and an
// team switcher that also creates new teams. Members/invites moved to
// their own Administration tab (members-panel.tsx).
//
// Teams are OPTIONAL: nothing is auto-created at sign-in. With zero teams
// this tab is hidden from the sidebar entirely (settings-page gating) —
// the empty state here is only a defensive fallback for the moment the
// last team disappears under an open panel.
//
// Role rules mirror the backend — the server is the enforcement, the UI
// just avoids offering doomed actions:
//   • rename / logo               → admin+
//   • delete team                 → owner only
// ──────────────────────────────────────────────────────────

import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronsUpDown,
  Copy,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, Input } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import {
  SETTINGS_CARD_LIST_CLS,
  SettingsEmpty,
  SettingsList,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-ui";
import {
  CONTROL_PLANE_URL,
  ControlPlaneError,
  controlPlane,
  type TeamRole,
  type TeamSummary,
} from "./control-plane";
import { setActiveTeamId } from "./active-team";
import { requestTeamResync } from "./team-sync";
import {
  refreshTeams,
  requestCreateTeamDialog,
  useActiveTeam,
  useTeams,
} from "./team-store";
import { TEAM_LOGO_ACCEPT, fileToTeamLogo } from "./team-logo";
import { cn } from "@/renderer/shared/ui/cn";

export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function errorMessage(err: unknown): string {
  if (err instanceof ControlPlaneError) return err.message;
  return "Something went wrong — try again";
}

/** The team's logo (or its initial) in a rounded square — shared by the
 *  switcher trigger, the rows, and the Members tab's context. */
export function TeamLogo({
  team,
  size = 32,
  className,
}: {
  team: { name: string; logo: string | null };
  size?: number;
  className?: string;
}) {
  const initial = (team.name.trim()[0] ?? "?").toUpperCase();
  return team.logo ? (
    <img
      src={team.logo}
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 rounded-lg object-cover", className)}
      style={{ width: size, height: size }}
      draggable={false}
    />
  ) : (
    <div
      aria-hidden
      className={cn(
        "bg-bg2-hover text-fg1 flex shrink-0 items-center justify-center rounded-lg font-medium",
        // Initial sizes off the type scale (RULES 1.3): 15px in the
        // 40px row avatar, 13px in the 28px switcher, 10px at list size.
        size >= 36 ? "text-[15px]" : size >= 24 ? "text-xs" : "text-[10px]",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {initial}
    </div>
  );
}

export function TeamPanel() {
  const { me, error, reload } = useTeams();
  const activeTeam = useActiveTeam();

  if (!CONTROL_PLANE_URL) {
    return (
      <SettingsEmpty
        title="Team service not configured"
        hint="Set VITE_CONTROL_PLANE_URL to your control-plane URL and restart the app."
      />
    );
  }
  if (error && !me) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-fg2 text-sm">{error}</p>
        <Button variant="secondary" size="sm" onClick={() => void reload()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!me) {
    return <div className="min-h-24" aria-busy="true" />;
  }
  if (!activeTeam) {
    // Normally unreachable (the sidebar hides this tab at zero teams) — a
    // defensive landing for the instant the last team is deleted/left.
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <SettingsEmpty
          title="No team yet"
          hint="Create one to invite teammates and share settings."
        />
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5"
          onClick={requestCreateTeamDialog}
        >
          <Plus size={14} />
          Create team
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <TeamSwitcher teams={me.teams} active={activeTeam} />
      <SettingsList className={SETTINGS_CARD_LIST_CLS}>
        <LogoRow key={`logo:${activeTeam.id}`} team={activeTeam} />
        <NameRow key={`name:${activeTeam.id}`} team={activeTeam} />
        <SettingsRow
          label="Team ID"
          hint="Your unique team identifier"
        >
          <TeamIdControl teamId={activeTeam.id} />
        </SettingsRow>
        <SettingsRow label="Your role" hint="What you can do in this team">
          <span className="text-fg2 text-sm">{ROLE_LABELS[activeTeam.role]}</span>
        </SettingsRow>
      </SettingsList>
      {activeTeam.role === "owner" && <DangerZone team={activeTeam} />}
    </div>
  );
}

// ── Team switcher — pick the active team, or create a new one ──
//
// A dropdown even with ONE team: it doubles as the "New team"
// entry point (the create modal), mirroring the workspace-switcher
// reference design.

function TeamSwitcher({
  teams,
  active,
}: {
  teams: TeamSummary[];
  active: TeamSummary;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch team"
          className="hover:bg-bg2 data-[state=open]:bg-bg2 flex w-fit max-w-full items-center gap-2.5 rounded-lg border-0 bg-transparent py-1.5 pr-2.5 pl-1.5 text-left outline-none"
        >
          <TeamLogo team={active} size={28} />
          <span className="text-fg1 truncate text-[14px] font-medium">
            {active.name}
          </span>
          <ChevronsUpDown className="text-fg2 size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel className="text-fg2">Teams</DropdownMenuLabel>
        {teams.map((o) => (
          <DropdownMenuItem
            key={o.id}
            data-selected={o.id === active.id || undefined}
            onSelect={() => setActiveTeamId(o.id)}
          >
            <TeamLogo team={o} size={20} />
            <span className="flex-1 truncate">{o.name}</span>
            {o.id === active.id ? (
              <Check className="text-fg1 ml-2 size-3.5 shrink-0" />
            ) : (
              <span className="ml-2 size-3.5 shrink-0" aria-hidden />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="bg-border3" />
        <DropdownMenuItem onSelect={requestCreateTeamDialog}>
          <Plus className="text-fg2 size-3.5 shrink-0" />
          New team
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Logo row — preview + Change/Remove (admin+) ──────────

function LogoRow({ team }: { team: TeamSummary }) {
  const canEdit = team.role !== "member";
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const apply = async (logo: string | null) => {
    setBusy(true);
    try {
      await controlPlane.updateTeam(team.id, { logo });
      await refreshTeams();
      toast.success(logo ? "Logo updated" : "Logo removed");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File | null) => {
    if (!file) return;
    try {
      await apply(await fileToTeamLogo(file));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that image");
    }
  };

  return (
    <SettingsRow label="Logo" hint="Shown for this team across Zeros">
      <div className="flex items-center gap-3">
        <TeamLogo team={ team } size={40} />
        {canEdit && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept={TEAM_LOGO_ACCEPT}
              className="hidden"
              onChange={(e) => {
                void pick(e.target.files?.[0] ?? null);
                e.target.value = ""; // re-selecting the same file re-fires
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Change
            </Button>
            {team.logo && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void apply(null)}
                className="text-fg2 hover:text-fg1"
              >
                Remove
              </Button>
            )}
          </>
        )}
      </div>
    </SettingsRow>
  );
}

// ── Name row — value + pencil, inline edit (admin+) ──────

function NameRow({ team }: { team: TeamSummary }) {
  const canEdit = team.role !== "member";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(team.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(team.name), [team.name]);

  const save = async () => {
    const name = draft.trim();
    if (!name || name === team.name) {
      setEditing(false);
      setDraft(team.name);
      return;
    }
    setBusy(true);
    try {
      await controlPlane.updateTeam(team.id, { name });
      await refreshTeams();
      requestTeamResync();
      setEditing(false);
      toast.success("Team renamed");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      label="Team name"
      hint="The name shown across Zeros and in invites"
      htmlFor={editing ? "team-name" : undefined}
    >
      {editing ? (
        <div className="flex items-center gap-2">
          <Input
            id="team-name"
            autoFocus
            value={draft}
            maxLength={80}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") {
                setEditing(false);
                setDraft(team.name);
              }
            }}
            className="w-[220px]"
          />
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setDraft(team.name);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-fg1 max-w-[280px] truncate text-sm">{team.name}</span>
          {canEdit && (
            <Tooltip label="Rename team">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                aria-label="Rename team"
                className="text-fg2 hover:text-fg1 size-7 px-0"
              >
                <Pencil size={13} />
              </Button>
            </Tooltip>
          )}
        </div>
      )}
    </SettingsRow>
  );
}

// ── ID — mono chip + copy ────────────────────────────────

function TeamIdControl({ teamId }: { teamId: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(teamId);
      toast.success("Team ID copied");
    } catch {
      toast.error("Couldn't copy — select the ID manually");
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="border-border2 bg-bg2/50 text-fg2 max-w-[300px] truncate rounded-sm border px-2 py-1 font-mono text-xs select-all">
        {teamId}
      </span>
      <Tooltip label="Copy team ID">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void copy()}
          aria-label="Copy team ID"
          className="text-fg2 hover:text-fg1 size-7 px-0"
        >
          <Copy size={13} />
        </Button>
      </Tooltip>
    </div>
  );
}

// ── Danger zone — owner-only delete, type-to-confirm ─────

function DangerZone({ team }: { team: TeamSummary }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <SettingsSection title="Danger zone">
      <SettingsList className={SETTINGS_CARD_LIST_CLS}>
        <SettingsRow
          label="Delete team"
          hint="Permanently removes this team for every member"
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            className="text-red-primary hover:bg-red-primary/10 hover:text-red-primary gap-1.5"
          >
            Delete team
          </Button>
        </SettingsRow>
      </SettingsList>
      <DeleteTeamDialog team={ team } open={confirmOpen} onOpenChange={setConfirmOpen} />
    </SettingsSection>
  );
}

function DeleteTeamDialog({
  team,
  open,
  onOpenChange,
}: {
  team: TeamSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setConfirmName("");
  }, [open]);
  const nameMatches = confirmName.trim() === team.name;

  const destroy = async () => {
    if (!nameMatches || busy) return;
    setBusy(true);
    try {
      await controlPlane.deleteTeam(team.id);
      // refreshTeams reconciles the active selection (next team, or null →
      // the Administration tabs hide and the engine team layer clears).
      await refreshTeams();
      requestTeamResync();
      onOpenChange(false);
      toast.success(`${team.name} deleted`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {team.name}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the team for every member —
            shared settings, membership, and pending invitations. This can't
            be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label htmlFor="confirm-team-name" className="text-fg1 text-sm font-medium">
            Type <span className="font-semibold">{team.name}</span> to confirm
          </label>
          <Input
            id="confirm-team-name"
            autoFocus
            value={confirmName}
            disabled={busy}
            onChange={(e) => setConfirmName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void destroy();
            }}
            placeholder={team.name}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={!nameMatches || busy}
            onClick={() => void destroy()}
            className="border-red-primary/40 text-red-primary hover:bg-red-primary/10 hover:text-red-primary gap-1.5"
          >
            <Trash2 size={14} />
            {busy ? "Deleting…" : "Delete team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
