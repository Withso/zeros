// ──────────────────────────────────────────────────────────
// Design agent drafts — live previews of Local agents' in-flight edits
// ──────────────────────────────────────────────────────────
//
// The local engine sends `DESIGN_AGENT_DRAFT` while an agent's Write/Edit of a
// Design source is still streaming (engine/design/agent-drafts.ts). This store
// keeps the newest revision of each draft, bounded per workspace and in total
// preview bytes, until the canvas hands it off to the saved frame. Drafts are
// transient: nothing is persisted, and the saved file stays authoritative.
// Cloud workspaces never receive drafts; their keys are ignored here.

import { create } from "zustand";
import {
  designAgentDraftSchema,
  type DesignAgentDraft,
} from "@zeros/protocol/design-agent-drafts";

import {
  getActiveBridge,
  onActiveBridgeChange,
} from "../../../platform/bridge/active-bridge";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";

export interface DesignAgentDraftEntry {
  draft: DesignAgentDraft;
  /** The newest preview, retained across later preview-less phase updates. */
  preview: DesignAgentDraft["preview"] | null;
  updatedAt: number;
  /** When the tool reported success; the canvas then hands the draft off. */
  savedAt: number | null;
}

interface DesignAgentDraftState {
  byWorkspace: Record<string, Record<string, DesignAgentDraftEntry>>;
}

const MAX_DRAFT_WORKSPACES = 8;
const MAX_DRAFTS_PER_WORKSPACE = 6;
const MAX_PREVIEW_CHARS = 24 * 1024 * 1024;
/** A streaming draft whose engine went quiet is dropped. */
export const DESIGN_AGENT_DRAFT_IDLE_MS = 120_000;
/** A saved draft the canvas never handed off is dropped. */
export const DESIGN_AGENT_DRAFT_SAVED_MS = 60_000;

const EMPTY_DRAFTS: Readonly<Record<string, DesignAgentDraftEntry>> = Object.freeze({});

export const useDesignAgentDraftStore = create<DesignAgentDraftState>(() => ({
  byWorkspace: {},
}));

let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function previewChars(entry: DesignAgentDraftEntry): number {
  return entry.preview?.srcDoc.length ?? 0;
}

/** Bound workspaces (least recently updated first), drafts per workspace and
 * retained preview text. Over budget, the oldest previews are released first;
 * their entries keep the status the canvas shows. */
function bound(
  byWorkspace: Record<string, Record<string, DesignAgentDraftEntry>>,
): Record<string, Record<string, DesignAgentDraftEntry>> {
  const latest = (drafts: Record<string, DesignAgentDraftEntry>) =>
    Math.max(0, ...Object.values(drafts).map((entry) => entry.updatedAt));
  let workspaces = Object.entries(byWorkspace).filter(
    ([, drafts]) => Object.keys(drafts).length > 0,
  );
  workspaces.sort(([, left], [, right]) => latest(right) - latest(left));
  workspaces = workspaces.slice(0, MAX_DRAFT_WORKSPACES).map(([id, drafts]) => {
    const entries = Object.entries(drafts)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_DRAFTS_PER_WORKSPACE);
    return [id, Object.fromEntries(entries)];
  });
  const all = workspaces
    .flatMap(([workspaceId, drafts]) =>
      Object.entries(drafts).map(([id, entry]) => ({ workspaceId, id, entry })),
    )
    .sort((left, right) => right.entry.updatedAt - left.entry.updatedAt);
  let budget = MAX_PREVIEW_CHARS;
  const next = Object.fromEntries(
    workspaces.map(([id, drafts]) => [id, { ...drafts }]),
  ) as Record<string, Record<string, DesignAgentDraftEntry>>;
  for (const { workspaceId, id, entry } of all) {
    const size = previewChars(entry);
    if (size <= budget) {
      budget -= size;
      continue;
    }
    next[workspaceId]![id] = { ...entry, preview: null };
  }
  return next;
}

function scheduleSweep(): void {
  if (sweepTimer) return;
  const drafts = Object.values(useDesignAgentDraftStore.getState().byWorkspace);
  if (!drafts.some((entries) => Object.keys(entries).length > 0)) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    sweepDesignAgentDrafts(Date.now());
    scheduleSweep();
  }, 5_000);
}

/** Drop drafts whose engine went quiet or whose save was never handed off. */
export function sweepDesignAgentDrafts(now: number): void {
  const { byWorkspace } = useDesignAgentDraftStore.getState();
  let changed = false;
  const next: Record<string, Record<string, DesignAgentDraftEntry>> = {};
  for (const [workspaceId, drafts] of Object.entries(byWorkspace)) {
    const kept: Record<string, DesignAgentDraftEntry> = {};
    for (const [id, entry] of Object.entries(drafts)) {
      const expired =
        entry.savedAt !== null
          ? now - entry.savedAt > DESIGN_AGENT_DRAFT_SAVED_MS
          : now - entry.updatedAt > DESIGN_AGENT_DRAFT_IDLE_MS;
      if (expired) changed = true;
      else kept[id] = entry;
    }
    if (Object.keys(kept).length > 0) next[workspaceId] = kept;
    else if (Object.keys(drafts).length > 0) changed = true;
  }
  if (changed) useDesignAgentDraftStore.setState({ byWorkspace: next });
}

/** Apply one validated engine message. Lower or repeated revisions are
 * ignored; an unsaved draft's discard removes it, while a saved draft stays
 * until the canvas hands it off. */
export function receiveDesignAgentDraft(
  workspaceId: unknown,
  value: unknown,
  now = Date.now(),
): void {
  if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 512)
    return;
  if (isCloudWorkspace(workspaceId)) return;
  const parsed = designAgentDraftSchema.safeParse(value);
  if (!parsed.success) return;
  const draft = parsed.data;
  const { byWorkspace } = useDesignAgentDraftStore.getState();
  const drafts = byWorkspace[workspaceId] ?? EMPTY_DRAFTS;
  const existing = drafts[draft.id];
  if (existing && existing.draft.revision >= draft.revision) return;
  const nextDrafts = { ...drafts };
  if (draft.phase === "discarded" && existing?.savedAt == null) {
    if (!existing) return;
    delete nextDrafts[draft.id];
  } else if (draft.phase === "discarded") {
    nextDrafts[draft.id] = { ...existing!, draft, updatedAt: now };
  } else {
    nextDrafts[draft.id] = {
      draft,
      preview: draft.preview ?? existing?.preview ?? null,
      updatedAt: now,
      savedAt:
        draft.phase === "saved" ? (existing?.savedAt ?? now) : (existing?.savedAt ?? null),
    };
  }
  useDesignAgentDraftStore.setState({
    byWorkspace: bound({ ...byWorkspace, [workspaceId]: nextDrafts }),
  });
  scheduleSweep();
}

/** The canvas painted the saved generation (or gave up waiting for it). */
export function retireDesignAgentDraft(workspaceId: string, draftId: string): void {
  const { byWorkspace } = useDesignAgentDraftStore.getState();
  const drafts = byWorkspace[workspaceId];
  if (!drafts?.[draftId]) return;
  const next = { ...drafts };
  delete next[draftId];
  const nextByWorkspace = { ...byWorkspace };
  if (Object.keys(next).length > 0) nextByWorkspace[workspaceId] = next;
  else delete nextByWorkspace[workspaceId];
  useDesignAgentDraftStore.setState({ byWorkspace: nextByWorkspace });
}

/** The exact workspace's drafts; a stable empty object when it has none. */
export function useDesignAgentDrafts(
  workspaceId: string | null | undefined,
): Readonly<Record<string, DesignAgentDraftEntry>> {
  return useDesignAgentDraftStore((state) =>
    workspaceId ? (state.byWorkspace[workspaceId] ?? EMPTY_DRAFTS) : EMPTY_DRAFTS,
  );
}

/** Drafts of one Design directory, newest first, keyed by Design file. Only
 * the most recent draft per file is shown. */
export function designAgentDraftsByFile(
  drafts: Readonly<Record<string, DesignAgentDraftEntry>>,
  directory: string | null | undefined,
): Map<string, DesignAgentDraftEntry> {
  const byFile = new Map<string, DesignAgentDraftEntry>();
  if (!directory) return byFile;
  const ordered = Object.values(drafts)
    .filter((entry) => entry.draft.directory === directory)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  for (const entry of ordered) {
    if (!byFile.has(entry.draft.file)) byFile.set(entry.draft.file, entry);
  }
  return byFile;
}

let eventsStarted = false;

/** Listen once per renderer. Local engines send drafts only to the trusted
 * desktop; switching bridges reattaches without replaying anything. */
export function startDesignAgentDraftEvents(): void {
  if (eventsStarted) return;
  eventsStarted = true;
  let stop: (() => void) | undefined;
  const attach = (bridge: ReturnType<typeof getActiveBridge>) => {
    stop?.();
    stop = bridge?.on("DESIGN_AGENT_DRAFT", (message) => {
      if (message.type !== "DESIGN_AGENT_DRAFT") return;
      receiveDesignAgentDraft(message.workspaceId, message.draft);
    });
  };
  attach(getActiveBridge());
  onActiveBridgeChange(attach);
}

/** Test-only reset. */
export function resetDesignAgentDraftsForTests(): void {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
  useDesignAgentDraftStore.setState({ byWorkspace: {} });
}
