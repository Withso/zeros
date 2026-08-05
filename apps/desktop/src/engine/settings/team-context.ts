// ──────────────────────────────────────────────────────────
// Team context — the engine-side slot for the team settings layer.
//
// The RENDERER owns the control-plane session (Auth0 JWT), fetches the
// active team's settings doc, and couriers it here over the LOCAL bridge
// (`team.setContext` — never remote-callable). The engine holds it IN
// MEMORY ONLY: the doc joins the resolve chain as the `team` layer
// (user < TEAM < repo < repo-local < workspace-local < managed).
// Nothing here is ever written to disk or into any settings.toml.
//
// (The shared-secrets vault was removed 2026-07-22 — no team-supplied
// secret values reach agent spawn env anymore; the team influences env
// only through the doc's [env] table, which spawn-env hazard-filters.)
// ──────────────────────────────────────────────────────────

import type { RawSettingsDoc } from "./schema";

type TeamContext = {
  teamId: string | null;
  doc: RawSettingsDoc | null;
};

let context: TeamContext = { teamId: null, doc: null };

export function setTeamContext(next: {
  teamId?: string | null;
  doc?: RawSettingsDoc | null;
}): void {
  context = {
    teamId: next.teamId ?? null,
    doc: next.doc ?? null,
  };
}

export function clearTeamContext(): void {
  context = { teamId: null, doc: null };
}

export function getTeamDoc(): RawSettingsDoc | null {
  return context.doc;
}

export function getTeamContextMeta(): { teamId: string | null } {
  return { teamId: context.teamId };
}
