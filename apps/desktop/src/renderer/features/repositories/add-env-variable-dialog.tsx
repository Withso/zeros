// ──────────────────────────────────────────────────────────
// Add / Edit secret — the Environment section's centered dialog
// ──────────────────────────────────────────────────────────
//
// Two ways in, one Save:
//
//   • SINGLE — type a Name + Value, Save stores that one variable. With
//     `initial` set the same dialog EDITS a stored variable: the fields open
//     pre-filled, and saving under a different Name renames it (the old
//     NAME is passed back as `renamedFrom` so the parent deletes it).
//   • BULK — paste a block of KEY=VALUE (a whole .env works; prose and
//     comments in between are ignored — env-paste.ts) straight into the
//     Name or Value field. There is no separate paste box: the hint under
//     Value describes the field's own paste behavior. The parsed pairs
//     REPLACE the Name/Value fields as a read-back list with a count;
//     whatever was typed in Name is deliberately discarded (the paste is
//     the newer intent). Clear returns to the fields as they were.
//
// Names the vault refuses (code-injection) and — on a repo page — names
// already set at the user scope are never imported silently: they're split
// out of the parse and called out under the fields.
//
// Persistence is the parent's job (onSave → env-vault write): this dialog
// never touches the Keychain itself, it only shapes {NAME: value} maps. The
// values it renders are either the user's own unpersisted paste or — in edit
// mode — the one stored value the user explicitly asked to edit.
// ──────────────────────────────────────────────────────────

import React, { useLayoutEffect, useRef, useState } from "react";

import { Button, Input, Textarea } from "../../shared/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { Label } from "../../shared/ui/primitives/label";
import { envVaultNameError } from "../agent/env-vault";
import {
  envPasteAction,
  type EnvPasteAction,
  type EnvPasteField,
  type EnvPastePair,
} from "./env-paste";

/** `prev` order kept, `add` overwrites values in place, new keys append. */
function mergePairs(
  prev: EnvPastePair[],
  add: EnvPastePair[],
): EnvPastePair[] {
  const map = new Map(prev.map((p) => [p.key, p.value]));
  for (const p of add) map.set(p.key, p.value);
  return [...map.entries()].map(([key, value]) => ({ key, value }));
}

const dedupe = (prev: string[], add: string[]): string[] => [
  ...new Set([...prev, ...add]),
];

export function AddEnvVariableDialog({
  open,
  onOpenChange,
  isUserScope,
  existingNames,
  reservedNames,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Copy only: where the saved variables will reach. */
  isUserScope: boolean;
  /** Names already stored in THIS scope — Save replaces their value. */
  existingNames: string[];
  /** Repo page: user-scope names, refused here (no override concept). */
  reservedNames: string[];
  /** Edit mode: the stored variable the dialog opens pre-filled with.
   *  Keep the object referentially stable while the dialog is open. */
  initial?: { name: string; value: string } | null;
  /** Persist the map (parent merges into the vault). `renamedFrom` is the
   *  stored NAME an edit moved away from — delete it. Resolve true to close. */
  onSave: (
    vars: Record<string, string>,
    opts: { renamedFrom?: string },
  ) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  /** Non-null = bulk mode: the parsed list replaces the Name/Value fields. */
  const [bulk, setBulk] = useState<EnvPastePair[] | null>(null);
  const [skippedUnsafe, setSkippedUnsafe] = useState<string[]>([]);
  const [skippedReserved, setSkippedReserved] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  /** Name/Value as they were when a bulk paste took over the dialog — Clear
   *  restores them, so a hijacking paste never destroys typed work. */
  const preBulk = useRef<{ name: string; value: string } | null>(null);

  const reset = () => {
    setName("");
    setValue("");
    setBulk(null);
    setSkippedUnsafe([]);
    setSkippedReserved([]);
    preBulk.current = null;
  };

  // Edit mode seeds the fields when the dialog opens; the parent keeps
  // `initial` referentially stable while open, so this fires once per open.
  // Layout effect: the fields must be filled before the dialog first paints.
  useLayoutEffect(() => {
    if (open && initial) {
      setName(initial.name);
      setValue(initial.value);
    }
  }, [open, initial]);

  /** Leave bulk mode, restoring whatever the fields held before it. */
  const clearBulk = () => {
    setBulk(null);
    setSkippedUnsafe([]);
    setSkippedReserved([]);
    setName(preBulk.current?.name ?? "");
    setValue(preBulk.current?.value ?? "");
    preBulk.current = null;
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  /** Route a parse result into the dialog. True = the paste was consumed
   *  (the caller preventDefaults so the raw text never lands in the field). */
  const applyAction = (action: EnvPasteAction): boolean => {
    // A VALUE that merely looks like `NODE_OPTIONS=…` pastes as plain text
    // and skips nothing — "Skipped" notes appear only on a consumed paste.
    if (action.kind === "none") return false;
    if (action.kind === "fill" && bulk === null) {
      // The pasted assignment replaces whatever was typed — Name included.
      setName(action.key);
      setValue(action.value);
      return true;
    }
    // In bulk mode a lone pair appends to the list instead of reviving the
    // Name/Value fields underneath it.
    const asPairs: EnvPastePair[] =
      action.kind === "fill"
        ? [{ key: action.key, value: action.value }]
        : action.pairs;
    const reserved = asPairs.filter((p) => reservedNames.includes(p.key));
    const ok = asPairs.filter((p) => !reservedNames.includes(p.key));
    if (action.kind === "bulk")
      setSkippedUnsafe((prev) => dedupe(prev, action.unsafe));
    setSkippedReserved((prev) =>
      dedupe(
        prev,
        reserved.map((p) => p.key),
      ),
    );
    if (ok.length > 0) {
      if (bulk === null) preBulk.current = { name, value };
      setBulk((prev) => mergePairs(prev ?? [], ok));
      setName("");
      setValue("");
    }
    return true;
  };

  const onFieldPaste =
    (field: EnvPasteField) => (e: React.ClipboardEvent<HTMLElement>) => {
      const clip = e.clipboardData.getData("text/plain");
      if (applyAction(envPasteAction(clip, field))) e.preventDefault();
    };

  const trimmedName = name.trim();
  const nameIssue = trimmedName
    ? (envVaultNameError(trimmedName) ??
      // Editing a var back under its own name is never "reserved" — even if
      // the same name meanwhile exists at the user level, this dialog edits
      // the repo entry that shadows it.
      (reservedNames.includes(trimmedName) && trimmedName !== initial?.name
        ? "already set at the user level"
        : null))
    : null;
  const replacesStored =
    !nameIssue &&
    trimmedName.length > 0 &&
    trimmedName !== initial?.name && // editing itself is not a replace
    existingNames.includes(trimmedName);
  /** Edit mode, Name changed: Save RENAMES — the old key is deleted. Said
   *  out loud because a pasted `KEY=VALUE` can change the Name field as a
   *  side effect the user may not have noticed. */
  const renames =
    !nameIssue &&
    initial != null &&
    trimmedName.length > 0 &&
    trimmedName !== initial.name;

  const canSave = bulk
    ? bulk.length > 0
    : trimmedName.length > 0 && !nameIssue;

  const handleSave = async () => {
    if (!canSave || saving) return;
    const vars = bulk
      ? Object.fromEntries(bulk.map((p) => [p.key, p.value]))
      : { [trimmedName]: value };
    // An edit saved under a new NAME is a rename: the old key must go. A bulk
    // paste during an edit only ADDS variables — the edited one stays unless
    // one of the pasted pairs overwrites it by name.
    const renamedFrom =
      !bulk && initial && initial.name !== trimmedName
        ? initial.name
        : undefined;
    setSaving(true);
    try {
      if (await onSave(vars, { renamedFrom })) handleOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        // Cancel is the one dismiss affordance (no X), and Escape is inert
        // while a save is in flight — a mid-save close would let the pending
        // write land on (or wipe) a reopened dialog.
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          if (saving) e.preventDefault();
        }}
        // In bulk mode the Name/Value fields are unmounted, so the dialog
        // itself keeps accepting pastes — another block appends to the list.
        // Unbubbled field pastes never reach here outside bulk mode.
        onPaste={(e) => {
          if (bulk === null || e.defaultPrevented) return;
          const clip = e.clipboardData.getData("text/plain");
          const action = envPasteAction(clip, "block");
          if (applyAction(action)) e.preventDefault();
          else if (action.kind === "none" && action.unsafe.length > 0)
            // Nothing importable, but the intent was unambiguous — say why.
            setSkippedUnsafe((prev) => dedupe(prev, action.unsafe));
        }}
      >
        <DialogHeader>
          <DialogTitle>{initial ? "Edit secret" : "Add secrets"}</DialogTitle>
          <DialogDescription>
            {isUserScope
              ? "For every agent on this Mac."
              : "For agents in this repo, in every workspace."}
          </DialogDescription>
        </DialogHeader>

        {bulk === null ? (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="add-env-var-name">Name</Label>
              <Input
                id="add-env-var-name"
                autoFocus
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onPaste={onFieldPaste("name")}
                placeholder="MY_VARIABLE"
                className="font-mono text-sm"
              />
              {nameIssue && (
                <p className="text-xs text-red-primary">
                  {trimmedName}: {nameIssue}
                </p>
              )}
              {replacesStored && (
                <p className="text-xs text-fg2">
                  {trimmedName} is already set — Save replaces its stored value
                </p>
              )}
              {renames && initial && (
                <p className="text-xs text-fg2">
                  Save renames {initial.name} to {trimmedName} — the old name
                  is removed
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="add-env-var-value">Value</Label>
              <Textarea
                id="add-env-var-value"
                rows={5}
                spellCheck={false}
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onPaste={onFieldPaste("value")}
                placeholder="value"
                className="font-mono text-sm"
              />
              <p className="text-xs text-fg2">
                Paste a block of KEY=VALUE to add multiple secrets
              </p>
            </div>
          </>
        ) : (
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <Label>Secrets</Label>
                <span className="text-xs text-fg2">{bulk.length}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={clearBulk}>
                Clear
              </Button>
            </div>
            <div className="max-h-56 divide-y divide-border1 overflow-y-auto rounded-md border border-border1 bg-bg1-highlight">
              {bulk.map((p) => (
                <div
                  key={p.key}
                  className="flex min-w-0 items-baseline gap-3 px-3 py-2"
                >
                  <span className="shrink-0 font-mono text-sm text-fg1">
                    {p.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg2">
                    {p.value}
                  </span>
                  {existingNames.includes(p.key) && (
                    <span className="shrink-0 text-xs text-muted-fg">
                      replaces stored
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {(skippedUnsafe.length > 0 || skippedReserved.length > 0) && (
          <div className="grid gap-1">
            {skippedUnsafe.length > 0 && (
              <p className="text-xs text-fg2">
                Skipped {skippedUnsafe.join(", ")} — unsafe to pass to agents
              </p>
            )}
            {skippedReserved.length > 0 && (
              <p className="text-xs text-fg2">
                Skipped {skippedReserved.join(", ")} — already set at the user
                level
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!canSave}
            loading={saving}
          >
            {bulk && bulk.length > 1 ? `Save ${bulk.length} secrets` : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
