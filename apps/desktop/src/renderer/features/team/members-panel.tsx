// ──────────────────────────────────────────────────────────
// Settings → Administration → Members
//
// Everything people-shaped for the ACTIVE team (the switcher lives on the
// Team tab; both tabs share the same active-team selection):
//   • invite composer — role + multi-email input + Send invite (admin+)
//   • the member list (role changes, remove/leave; server-mirrored rules)
//   • pending invitations (admin+)
//   • join a team by pasting an invite link (deep-linked invites
//     open the Join dialog at the settings-page level instead)
//
// Role rules mirror the backend — the server is the enforcement, the UI
// just avoids offering doomed actions:
//   • invite / role change / remove   → admin+
//   • touching an owner role          → owner only
//   • last owner can't be demoted/removed (server 409 → toast)
// ──────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button, Input } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives/select";
import {
  SETTINGS_CARD_LIST_CLS,
  SettingsEmpty,
  SettingsList,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-ui";
import {
  CONTROL_PLANE_URL,
  controlPlane,
  type TeamInvitation,
  type TeamMember,
  type TeamRole,
  type TeamSummary,
} from "./control-plane";
import { parseInviteToken } from "./invite-link";
import { requestTeamResync } from "./team-sync";
import { setActiveTeamId } from "./active-team";
import { refreshTeams, useActiveTeam, useTeams } from "./team-store";
import { MAX_INVITES_PER_BATCH, parseInviteEmails } from "./invite-emails";
import { ROLE_LABELS, errorMessage } from "./team-panel";

export function MembersPanel() {
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
    // Defensive only — the sidebar hides this tab at zero teams.
    return (
      <SettingsEmpty
        title="No team yet"
        hint="Create a team to invite teammates."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <MembersBody
        key={activeTeam.id}
        team={activeTeam}
        myUserId={me.user.id}
        refreshMe={async () => {
          await reload();
        }}
      />
      <JoinTeamSection />
    </div>
  );
}

function MembersBody({
  team,
  myUserId,
  refreshMe,
}: {
  team: TeamSummary;
  myUserId: string;
  /** Refetch the top-level `me` so `team.role` updates after a change that
   *  affects the current user (self-demote/leave) — otherwise the panel
   *  keeps offering admin controls the server will now reject. */
  refreshMe: () => Promise<void>;
}) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);

  const iAmAdmin = team.role === "admin" || team.role === "owner";
  const iAmOwner = team.role === "owner";

  const reload = useCallback(async () => {
    // Members are the core view — loaded independently of invitations so an
    // invitations 403 (role revoked out from under us) can't strand the
    // panel on "Loading members…".
    try {
      const m = await controlPlane.listMembers(team.id);
      setMembers(m.members);
    } catch (err) {
      toast.error(errorMessage(err));
    }
    if (iAmAdmin) {
      try {
        const inv = await controlPlane.listInvitations(team.id);
        setInvitations(inv.invitations);
      } catch {
        setInvitations([]); // lost admin, or a blip — just hide the section
      }
    } else {
      setInvitations([]);
    }
  }, [team.id, iAmAdmin]);

  // A change to my OWN membership must refresh my role, then reload the lists.
  const reloadAfterSelfChange = useCallback(async () => {
    await refreshMe();
    await reload();
  }, [refreshMe, reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <SettingsSection
        title="Members"
        description="Invited teammates get an email with a join link. A single invite's link is also copied for you to share directly."
      >
        {iAmAdmin && <InviteComposer teamId={team.id} onInvited={reload} />}
        {members === null ? (
          <div className="min-h-16" aria-busy="true" />
        ) : (
          <SettingsList className={SETTINGS_CARD_LIST_CLS}>
            {members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                teamId={team.id}
                isSelf={m.id === myUserId}
                iAmAdmin={iAmAdmin}
                iAmOwner={iAmOwner}
                onChanged={m.id === myUserId ? reloadAfterSelfChange : reload}
              />
            ))}
          </SettingsList>
        )}
      </SettingsSection>

      {iAmAdmin && invitations.length > 0 && (
        <SettingsSection
          title="Pending invitations"
          description="Waiting to be accepted. Re-inviting the same email replaces the old link."
        >
          <SettingsList className={SETTINGS_CARD_LIST_CLS}>
            {invitations.map((inv) => (
              <PendingInviteRow
                key={inv.id}
                invitation={inv}
                teamId={team.id}
                onChanged={reload}
              />
            ))}
          </SettingsList>
        </SettingsSection>
      )}
    </>
  );
}

// ── Invite composer — role + emails + Send invite ────────
//
// One input, many invites: comma/space/newline-separated emails go out as
// individual invitations at the picked role. Matches the reference design
// ([Admin ▾] [Invite by email…] [Send invite]).

function InviteComposer({
  teamId,
  onInvited,
}: {
  teamId: string;
  onInvited: () => Promise<void>;
}) {
  const [raw, setRaw] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);

  const parsed = parseInviteEmails(raw);
  const canSend =
    !busy &&
    parsed.valid.length > 0 &&
    parsed.invalid.length === 0 &&
    parsed.valid.length <= MAX_INVITES_PER_BATCH;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    const sent: string[] = [];
    const failed: Array<{ email: string; message: string }> = [];
    let firstLink: string | null = null;
    // Sequential on purpose: bounded (≤20), keeps the server's per-admin
    // rate limit honest, and attributes failures to specific addresses.
    for (const email of parsed.valid) {
      try {
        const { invitation } = await controlPlane.createInvitation(
          teamId,
          email,
          role,
        );
        sent.push(email);
        firstLink ??= invitation.acceptUrl;
      } catch (err) {
        failed.push({ email, message: errorMessage(err) });
      }
    }
    if (sent.length === 1 && firstLink) {
      await navigator.clipboard.writeText(firstLink).catch(() => {});
      toast.success(`Invitation sent to ${sent[0]} — join link copied`);
    } else if (sent.length > 1) {
      toast.success(`${sent.length} invitations sent`);
    }
    if (failed.length > 0) {
      toast.error(
        `Couldn't invite ${failed.map((f) => f.email).join(", ")} — ${failed[0]!.message}`,
      );
    }
    if (sent.length > 0) {
      setRaw("");
      await onInvited();
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Select
          value={role}
          onValueChange={(v) => setRole(v as "member" | "admin")}
        >
          <SelectTrigger size="sm" className="min-w-[100px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Invite by email, separated by spaces or commas"
          type="text"
          aria-label="Invite by email"
          spellCheck={false}
          className="min-w-0 flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!canSend}
          onClick={() => void send()}
          className="shrink-0 gap-1.5"
        >
          <Plus size={14} />
          {busy ? "Sending…" : "Send invite"}
        </Button>
      </div>
      {parsed.invalid.length > 0 && (
        <p className="text-fg2 text-xs">
          Not an email: {parsed.invalid.slice(0, 3).join(", ")}
          {parsed.invalid.length > 3 ? "…" : ""}
        </p>
      )}
      {parsed.valid.length > MAX_INVITES_PER_BATCH && (
        <p className="text-fg2 text-xs">
          Up to {MAX_INVITES_PER_BATCH} invitations at a time.
        </p>
      )}
    </div>
  );
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

function PendingInviteRow({
  invitation,
  teamId,
  onChanged,
}: {
  invitation: TeamInvitation;
  teamId: string;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const days = daysUntil(invitation.expires_at);
  const revoke = async () => {
    setBusy(true);
    try {
      await controlPlane.revokeInvitation(teamId, invitation.id);
      await onChanged();
      toast.success(`Invitation to ${invitation.email} revoked`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      label={invitation.email}
      hint={`${ROLE_LABELS[invitation.role]} · expires in ${days} day${days === 1 ? "" : "s"}`}
    >
      <Tooltip label="Revoke invitation">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void revoke()}
          aria-label={`Revoke invitation to ${invitation.email}`}
          className="text-fg2 hover:text-red-primary size-7 px-0"
        >
          <X size={14} />
        </Button>
      </Tooltip>
    </SettingsRow>
  );
}

function MemberRow({
  member,
  teamId,
  isSelf,
  iAmAdmin,
  iAmOwner,
  onChanged,
}: {
  member: TeamMember;
  teamId: string;
  isSelf: boolean;
  iAmAdmin: boolean;
  iAmOwner: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const name = member.display_name?.trim() || member.email;
  const initial = (name[0] ?? "?").toUpperCase();
  // Owner rows (and granting owner) are owner-only territory; the server
  // enforces the same rule — the UI just doesn't offer doomed controls.
  const canEditRole = iAmAdmin && (member.role !== "owner" || iAmOwner);
  const canRemove =
    (iAmAdmin && (member.role !== "owner" || iAmOwner)) || isSelf;

  const setRole = async (role: TeamRole) => {
    setBusy(true);
    try {
      await controlPlane.setMemberRole(teamId, member.id, role);
      await onChanged();
      toast.success(`${name} is now ${ROLE_LABELS[role].toLowerCase()}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await controlPlane.removeMember(teamId, member.id);
      if (isSelf) {
        // Leaving: reconcile the active team (falls back to the next team, or
        // clears at zero) and re-courier the engine layer. Deliberately NO
        // onChanged() here — we're no longer a member, so re-listing THIS
        // team would 404 into a spurious error toast; the active-team change
        // remounts/unmounts MembersBody with fresh data.
        await refreshTeams();
        requestTeamResync();
      } else {
        await onChanged();
      }
      toast.success(isSelf ? "You left the team" : `${name} removed`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="bg-bg2-hover text-fg1 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium">
          {initial}
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="text-fg1 truncate text-[14px] font-medium">
            {name}
            {isSelf && <span className="text-fg2 font-normal"> (you)</span>}
          </span>
          <span className="text-fg2 truncate text-xs">{member.email}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canEditRole ? (
          <Select
            value={member.role}
            onValueChange={(v) => void setRole(v as TeamRole)}
            disabled={busy}
          >
            <SelectTrigger size="sm" className="min-w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              {iAmOwner && <SelectItem value="owner">Owner</SelectItem>}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-fg2 text-xs">{ROLE_LABELS[member.role]}</span>
        )}
        {canRemove && (
          <Tooltip label={isSelf ? "Leave team" : `Remove ${name}`}>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              aria-label={isSelf ? "Leave team" : `Remove ${name}`}
              className="text-fg2 hover:text-red-primary size-7 px-0"
            >
              <Trash2 size={14} />
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ── Join a team — paste a link (manual path) ────
//
// Deep-linked invites open the Join dialog at the settings-page level;
// this box is for a link pasted from anywhere else.

function JoinTeamSection() {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = parseInviteToken(draft);

  const join = async () => {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { team } = await controlPlane.acceptInvitation(token);
      setDraft("");
      toast.success(`Welcome to ${team.name}`);
      await refreshTeams();
      setActiveTeamId(team.id);
      requestTeamResync();
    } catch (err) {
      // wrong_account / invalid_invite come back with exact, safe copy
      // (masked email; no existence oracle) — show them inline where the
      // user is looking, not as a transient toast.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Join a team"
      description="Paste an invite link (or the code from an invite email)."
    >
      <div className="flex max-w-md items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          placeholder="https://app.zeros.build/invite?token=…"
          aria-label="Invite link or code"
          onKeyDown={(e) => {
            if (e.key === "Enter") void join();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!token || busy}
          onClick={() => void join()}
        >
          {busy ? "Joining…" : "Join"}
        </Button>
      </div>
      {draft.trim() && !token && (
        <p className="text-fg2 text-xs">
          That doesn't look like an invite link or code.
        </p>
      )}
      {error && <p className="text-red-primary text-xs">{error}</p>}
    </SettingsSection>
  );
}
