// ──────────────────────────────────────────────────────────
// Run actions — the repo page's Environment view, below Setup / Archive
// ──────────────────────────────────────────────────────────
//
// The add/edit/delete editor over `[[scripts.run_actions]]`: each card is an
// icon button (searchable picker) + Name + multiline Command + the
// Run-on-create / Default toggles. Each card owns its Save affordance; because
// TOML arrays replace atomically, that save merges only the selected draft onto
// the latest saved array before writing it. Platform filters are omitted while
// Zeros is Mac-only; pass/fail mode is inferred from the command by the engine.
// NOT called "Actions" — Settings already has an Actions section (agent
// prompts).
//
// Migration: with no saved run_actions, the editor seeds from the effective
// legacy `scripts.run` string (one default "run" action) so the first save
// upgrades the repo to the actions model without hand-editing TOML.
// ──────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { parseRunActions, type RunAction } from "@zeros/protocol/run-actions";

import { Button } from "../../shared/ui";
import { CodeTextarea, Input, Switch, Tooltip } from "../../shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import { IconPicker } from "../../shared/ui/icon-picker";
import { DEFAULT_RUN_ICON } from "../../shared/ui/icon-registry";
import {
  useResolvedSettings,
  useSettingsLayer,
} from "../settings/use-settings";
import { SettingsEmptyCard, SettingsSection } from "../settings/settings-ui";
import type { Project } from "../../state/projects-store";
import type { EditableRepoLayer } from "./repositories-panel";

interface ActionDraft {
  id: string;
  name: string;
  command: string;
  icon: string;
  runOnCreate: boolean;
  isDefault: boolean;
}

function mintActionId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function toDraft(a: RunAction): ActionDraft {
  return {
    id: a.id,
    name: a.name,
    command: a.command,
    icon: a.icon ?? DEFAULT_RUN_ICON,
    runOnCreate: a.runOnCreate ?? false,
    isDefault: a.isDefault ?? false,
  };
}

/** The snake_case TOML table one draft persists as. */
function toTomlTable(d: ActionDraft): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name.trim(),
    command: d.command.trim(),
    icon: d.icon,
    run_on_create: d.runOnCreate,
    default: d.isDefault,
  };
}

function sameDraft(a: ActionDraft | undefined, b: ActionDraft): boolean {
  return (
    a?.id === b.id &&
    a.name.trim() === b.name.trim() &&
    a.command.trim() === b.command.trim() &&
    a.icon === b.icon &&
    a.runOnCreate === b.runOnCreate &&
    a.isDefault === b.isDefault
  );
}

/** Names are user-facing identifiers, unique after trimming and case-folding. */
function findDuplicateActionName(drafts: ActionDraft[]): string | null {
  const seen = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) return name;
    seen.add(normalized);
  }
  return null;
}

/** Preserve locally diverged cards while adopting external/successful writes. */
function mergeSeedChange(
  current: ActionDraft[],
  previousSeed: ActionDraft[],
  nextSeed: ActionDraft[],
): ActionDraft[] {
  const previousById = new Map(previousSeed.map((draft) => [draft.id, draft]));
  const nextById = new Map(nextSeed.map((draft) => [draft.id, draft]));
  const merged: ActionDraft[] = [];

  for (const draft of current) {
    const previous = previousById.get(draft.id);
    const next = nextById.get(draft.id);
    if (previous && sameDraft(previous, draft)) {
      // This card was clean, so it can safely follow the saved layer (including
      // an external deletion).
      if (next) merged.push(next);
    } else if (next && sameDraft(next, draft)) {
      // A card we just saved now matches the incoming layer.
      merged.push(next);
    } else {
      // Unsaved edit or locally-added card — never clobber it in the background.
      merged.push(draft);
    }
  }

  const represented = new Set(merged.map((draft) => draft.id));
  for (const draft of nextSeed) {
    if (!represented.has(draft.id)) merged.push(draft);
  }
  return merged;
}

function withSingleDefault(
  drafts: ActionDraft[],
  preferredId?: string,
): ActionDraft[] {
  if (drafts.length === 0) return drafts;
  const defaultId =
    (preferredId && drafts.some((draft) => draft.id === preferredId)
      ? preferredId
      : drafts.find((draft) => draft.isDefault)?.id) ?? drafts[0]!.id;
  return drafts.map((draft) => ({
    ...draft,
    isDefault: draft.id === defaultId,
  }));
}

export function RunActionsSection({
  project,
  layer,
  root,
  mainRepoRoot,
}: {
  project: Project;
  layer: EditableRepoLayer;
  root: string;
  mainRepoRoot?: string;
}) {
  const resolved = useResolvedSettings(root, mainRepoRoot);
  const repo = useSettingsLayer(layer, root);

  // What THIS layer has saved (raw), and the effective view (for the legacy-
  // migration seed when the layer has no actions yet).
  const savedRaw = useMemo(() => {
    const doc = (repo.layer?.doc ?? {}) as {
      scripts?: { run_actions?: unknown };
    };
    return Array.isArray(doc.scripts?.run_actions)
      ? doc.scripts.run_actions
      : null;
  }, [repo.layer?.doc]);
  const seed = useMemo(() => {
    if (savedRaw)
      return parseRunActions({ run_actions: savedRaw }).map(toDraft);
    // No actions saved on THIS layer. Seed only the legacy `scripts.run`
    // migration (one default "run" action) — and only when NO layer defines
    // run_actions; seeding from another layer's actions would copy the whole
    // array here on the first save and shadow that layer. A repo with
    // nothing configured seeds [].
    const effective = resolved.resolved?.effective.scripts as
      | { run?: unknown; run_actions?: unknown }
      | undefined;
    if (
      Array.isArray(effective?.run_actions) &&
      effective.run_actions.length > 0
    )
      return [];
    return parseRunActions({ run: effective?.run }).map(toDraft);
  }, [savedRaw, resolved.resolved]);

  const [drafts, setDrafts] = useState<ActionDraft[]>(seed);
  // Re-sync clean cards when the saved doc changes under us, without dropping
  // an edit in another card while one action is being saved.
  const seedKey = JSON.stringify(seed);
  const previousSeedRef = useRef<ActionDraft[]>(seed);
  useEffect(() => {
    const nextSeed = JSON.parse(seedKey) as ActionDraft[];
    const previousSeed = previousSeedRef.current;
    previousSeedRef.current = nextSeed;
    setDrafts((current) => mergeSeedChange(current, previousSeed, nextSeed));
  }, [seedKey]);

  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const savedById = useMemo(
    () => new Map(seed.map((draft) => [draft.id, draft])),
    [seed],
  );

  const update = (id: string, patch: Partial<ActionDraft>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const setDefault = (id: string) =>
    setDrafts((ds) => ds.map((d) => ({ ...d, isDefault: d.id === id })));

  const add = () =>
    setDrafts((ds) => [
      ...ds,
      {
        id: mintActionId(),
        name: "",
        command: "",
        icon: DEFAULT_RUN_ICON,
        runOnCreate: false,
        isDefault: ds.length === 0,
      },
    ]);

  const writeActions = async (next: ActionDraft[]) => {
    await repo.write({
      scripts: {
        // ALWAYS an array — an explicit [] means "none configured", which
        // keeps the legacy `run` string (any layer) from resurrecting a
        // deleted action at read time.
        run_actions: next.map(toTomlTable),
        // This section supersedes the legacy single `run` string; clear it
        // from the edited layer so the two can't drift apart.
        run: null,
      },
    });
  };

  const handleSave = async (id: string) => {
    const draft = drafts.find((candidate) => candidate.id === id);
    if (!draft || !draft.name.trim() || !draft.command.trim() || mutatingId)
      return;

    const duplicateName = findDuplicateActionName(drafts);
    if (duplicateName) {
      toast.error(`A run action named “${duplicateName}” already exists`);
      return;
    }

    // Only this card's fields are committed. Default is a list-wide invariant,
    // so selecting this card as default also clears the saved flag elsewhere.
    const selectedDefault = drafts.find((candidate) => candidate.isDefault);
    const selectedDefaultIsPersistable =
      selectedDefault?.id === id ||
      seed.some((candidate) => candidate.id === selectedDefault?.id);
    const existingDefaultId = seed.find((candidate) => candidate.isDefault)?.id;
    const preferredDefaultId = draft.isDefault
      ? draft.id
      : selectedDefaultIsPersistable
        ? selectedDefault?.id
        : existingDefaultId;
    const nextSaved = withSingleDefault(
      seed.some((candidate) => candidate.id === id)
        ? seed.map((candidate) => (candidate.id === id ? draft : candidate))
        : [...seed, draft],
      preferredDefaultId,
    );

    setMutatingId(id);
    try {
      await writeActions(nextSaved);
      toast.success(`${draft.name.trim()} saved`);
    } catch {
      toast.error(`Couldn't save ${draft.name.trim() || "run action"}`);
    } finally {
      setMutatingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (mutatingId) return;
    const savedDraft = savedById.get(id);
    if (!savedDraft) {
      setDrafts((current) => current.filter((draft) => draft.id !== id));
      return;
    }

    const selectedDefaultId = drafts.find(
      (draft) => draft.id !== id && draft.isDefault,
    )?.id;
    const nextSaved = withSingleDefault(
      seed.filter((draft) => draft.id !== id),
      selectedDefaultId,
    );
    setMutatingId(id);
    try {
      await writeActions(nextSaved);
      setDrafts((current) => current.filter((draft) => draft.id !== id));
      toast.success(`${savedDraft.name} deleted`);
    } catch {
      toast.error(`Couldn't delete ${savedDraft.name}`);
    } finally {
      setMutatingId(null);
    }
  };

  return (
    <SettingsSection
      title="Run actions"
      description="Shortcuts for quick actions"
      action={
        drafts.length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            onClick={add}
            disabled={repo.loading || mutatingId !== null}
            className="gap-1.5"
          >
            <Plus className="size-3.5" strokeWidth={1} aria-hidden="true" />
            Add action
          </Button>
        ) : undefined
      }
    >
      {drafts.length === 0 && !repo.loading && (
        <SettingsEmptyCard
          title="No run actions yet"
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={add}
              disabled={mutatingId !== null}
              className="gap-1.5"
            >
              <Plus className="size-3.5" strokeWidth={1} aria-hidden="true" />
              Add
            </Button>
          }
        />
      )}
      {drafts.length > 0 && (
        <div className="flex flex-col gap-3">
          {drafts.map((draft) => (
            <ActionCard
              key={draft.id}
              projectId={project.id}
              draft={draft}
              savedDraft={savedById.get(draft.id)}
              busy={repo.loading || mutatingId !== null}
              onChange={(patch) => update(draft.id, patch)}
              onMakeDefault={() => setDefault(draft.id)}
              onDelete={() => void handleDelete(draft.id)}
              onSave={() => void handleSave(draft.id)}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

function ActionCard({
  projectId,
  draft,
  savedDraft,
  busy,
  onChange,
  onMakeDefault,
  onDelete,
  onSave,
}: {
  projectId: string;
  draft: ActionDraft;
  savedDraft?: ActionDraft;
  busy: boolean;
  onChange: (patch: Partial<ActionDraft>) => void;
  onMakeDefault: () => void;
  onDelete: () => void;
  onSave: () => void;
}) {
  const dirty = !savedDraft || !sameDraft(savedDraft, draft);
  const invalid = !draft.name.trim() || !draft.command.trim();

  return (
    <div className="border-border1 overflow-hidden rounded-lg border">
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <IconPicker
            value={draft.icon}
            onChange={(icon) => onChange({ icon })}
            label={`Icon for ${draft.name || "action"}`}
          />
          <Input
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            aria-label="Action name"
            id={`run-action-name-${projectId}-${draft.id}`}
            className="border-border1 h-7 min-w-0 flex-1 bg-transparent text-xs"
          />
        </div>
        <CodeTextarea
          value={draft.command}
          onChange={(command) => onChange({ command })}
          aria-label={`Command for ${draft.name || "action"}`}
        />
        <div className="flex items-center justify-between gap-4">
          <div className="text-fg2 flex min-w-0 items-center gap-x-4 text-xs">
            <label className="flex cursor-pointer items-center gap-1.5">
              <Switch
                checked={draft.runOnCreate}
                onCheckedChange={(runOnCreate) => onChange({ runOnCreate })}
                aria-label="Run on workspace create"
              />
              Run on create
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <Switch
                checked={draft.isDefault}
                onCheckedChange={(next) => {
                  if (next) onMakeDefault();
                }}
                aria-label="Default action (header button + ⌘R)"
              />
              Default (⌘R)
            </label>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip label="Delete action">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${draft.name || "action"}`}
                onClick={onDelete}
                disabled={busy}
                className="text-fg2 hover:text-red-primary"
              >
                <Trash2 strokeWidth={1} />
              </Button>
            </Tooltip>
            <Button
              variant="secondary"
              size="sm"
              onClick={onSave}
              disabled={busy || !dirty || invalid}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
