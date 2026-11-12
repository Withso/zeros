// PURPOSE: Which variant a main component frame shows: personal view state,
// per workspace and frame, never written to Git or to the engine. It is read
// back synchronously on load, so the frame's first document is already the
// variant; it is shown only while the frame declares that variant, and an
// entry for a variant or a frame that has gone is dropped. Local only.

import { isDesignComponentVariantName, isDesignFrameFile } from "@zeros/protocol/design-path";
import type { DesignFrameComponent } from "@zeros/protocol/design-catalog";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/bridge/design-bridge";
import { isDesignWorkspaceBootPreview } from "./design-workspace-boot-cache";
import { create } from "zustand";

const STORAGE_KEY = "zeros:design-component-variants-v1";
const MAX_WORKSPACES = 32;
const MAX_FRAMES_PER_WORKSPACE = 64;
const PERSIST_DEBOUNCE_MS = 150;

interface WorkspaceVariants {
  /** Frame file to variant name, least recently chosen first. */
  frames: Record<string, string>;
  updatedAt: number;
}

type Stored = Record<string, WorkspaceVariants>;

function normalize(value: unknown): Stored {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: [string, WorkspaceVariants][] = [];
  for (const [workspaceId, record] of Object.entries(value as Record<string, unknown>)) {
    if (!workspaceId.trim() || workspaceId.length > 128 || !record || typeof record !== "object") continue;
    const frames = (record as { frames?: unknown }).frames;
    const updatedAt = (record as { updatedAt?: unknown }).updatedAt;
    if (!frames || typeof frames !== "object" || Array.isArray(frames)) continue;
    const kept = Object.entries(frames as Record<string, unknown>)
      .filter((entry): entry is [string, string] => isDesignFrameFile(entry[0]) && isDesignComponentVariantName(entry[1]))
      .slice(-MAX_FRAMES_PER_WORKSPACE);
    if (kept.length) entries.push([workspaceId, { frames: Object.fromEntries(kept), updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0 }]);
  }
  return Object.fromEntries(entries.sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, MAX_WORKSPACES));
}

function load(): Stored {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(write, PERSIST_DEBOUNCE_MS);
}
function write(): void {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(useDesignComponentVariantStore.getState().byWorkspace));
  } catch {
    // View state is best effort in private or full storage.
  }
}

export const useDesignComponentVariantStore = create<{ byWorkspace: Stored }>(() => ({ byWorkspace: load() }));

function update(workspaceId: string, change: (frames: Record<string, string>) => Record<string, string>): void {
  const { byWorkspace } = useDesignComponentVariantStore.getState();
  const current = byWorkspace[workspaceId]?.frames ?? {};
  const frames = change(current);
  if (frames === current) return;
  const next: Stored = { ...byWorkspace };
  if (Object.keys(frames).length) next[workspaceId] = { frames, updatedAt: Date.now() };
  else delete next[workspaceId];
  useDesignComponentVariantStore.setState({ byWorkspace: normalize(next) });
  persist();
}

/** The variants a frame's declaration names. */
export function designDeclaredVariants(component: DesignFrameComponent | undefined): string[] {
  if (!component) return [];
  return component.elements
    .filter((element) => element.tag === "zd-variant")
    .map((element) => element.attributes.find((attribute) => attribute.name === "name")?.value ?? "")
    .filter(isDesignComponentVariantName);
}

function shownFrom(stored: Stored, workspaceId: string, frame: { file: string; component?: DesignFrameComponent }): string | null {
  const variant = stored[workspaceId]?.frames[frame.file];
  return variant && designDeclaredVariants(frame.component).includes(variant) ? variant : null;
}

/** The variant this frame shows, or null for its defaults. */
export function designShownComponentVariant(workspaceId: string, frame: { file: string; component?: DesignFrameComponent }): string | null {
  return shownFrom(useDesignComponentVariantStore.getState().byWorkspace, workspaceId, frame);
}

export function useDesignShownComponentVariant(workspaceId: string, frame: { file: string; component?: DesignFrameComponent }): string | null {
  return useDesignComponentVariantStore((state) => shownFrom(state.byWorkspace, workspaceId, frame));
}

/** Show a variant on a main frame, or its defaults (null). */
export function showDesignComponentVariant(workspaceId: string, file: string, variant: string | null): void {
  if (variant !== null && !isDesignComponentVariantName(variant)) throw new Error("That is not a variant's name.");
  update(workspaceId, (frames) => {
    if ((frames[file] ?? null) === variant) return frames;
    const { [file]: _dropped, ...rest } = frames;
    return variant === null ? rest : { ...rest, [file]: variant };
  });
}

/** Drop what no longer has a frame (`files`: every frame the directory
 * has, when known) or whose frame no longer declares its variant. */
export function pruneDesignComponentVariants(
  workspaceId: string,
  input: { frames: readonly { file: string; component?: DesignFrameComponent }[]; files?: readonly string[] },
): void {
  update(workspaceId, (frames) => {
    const known = new Map(input.frames.map((frame) => [frame.file, frame]));
    const files = input.files ? new Set(input.files) : null;
    const kept = Object.entries(frames).filter(([file, variant]) => {
      const frame = known.get(file);
      return !((files !== null && !files.has(file)) || (frame !== undefined && !designDeclaredVariants(frame.component).includes(variant)));
    });
    return kept.length === Object.keys(frames).length ? frames : Object.fromEntries(kept);
  });
}

/** Prune against what a directory snapshot confirms. A record that is not
 * current (the boot preview's, or one of a catalog still being prepared)
 * cannot say which variants its frame declares, so it removes nothing. */
export function pruneDesignComponentVariantsFor(workspaceId: string, snapshot: DesignWorkspaceSnapshotWire): void {
  if (!useDesignComponentVariantStore.getState().byWorkspace[workspaceId] || isDesignWorkspaceBootPreview(snapshot)) return;
  const current = snapshot.preparation ? new Set(snapshot.preparation.current) : null;
  pruneDesignComponentVariants(workspaceId, {
    frames: current ? snapshot.frames.filter((frame) => current.has(frame.file)) : snapshot.frames,
    files: snapshot.preparation ? snapshot.preparation.descriptions.map((frame) => frame.file)
      : snapshot.pages?.length ? snapshot.pages.flatMap((page) => page.frameFiles) : snapshot.frames.map((frame) => frame.file),
  });
}

export function designComponentVariantsForTests(workspaceId: string): Record<string, string> {
  return { ...(useDesignComponentVariantStore.getState().byWorkspace[workspaceId]?.frames ?? {}) };
}

export function flushDesignComponentVariantsForTests(): void {
  write();
}
