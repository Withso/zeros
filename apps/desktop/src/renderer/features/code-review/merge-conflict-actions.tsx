import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyConflictChoices,
  parseMergeConflicts,
  type ConflictChoice,
} from "@zeros/protocol/git-review-actions";
import {
  workspaceGitReviewClient,
  type GitReviewActionsClient,
} from "@/renderer/platform/git-review-actions";
import { Button } from "@/renderer/shared/ui/primitives/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/shared/ui/primitives/dialog";

export interface MergeConflictActionsProps {
  cwd: string;
  path: string;
  /** Confirmed disk content, never the changing editor preview. */
  content: string;
  isGitConflict: boolean;
  active?: boolean;
  readOnly?: boolean;
  designPath?: boolean;
  onPreview: (content: string) => void;
  onSaved: (content: string) => void;
  /** Parent retains the request lifetime when its preview surface is hidden. */
  onSavingChange?: (saving: boolean) => void;
  client?: GitReviewActionsClient;
}
export function MergeConflictActions(props: MergeConflictActionsProps) {
  const owner = JSON.stringify([
    props.client?.identity ?? workspaceGitReviewClient.identity,
    props.cwd,
    props.path,
  ]);
  return <ConflictDraft key={owner} {...props} />;
}

function ConflictDraft({
  cwd,
  path,
  content,
  isGitConflict,
  active = true,
  readOnly = false,
  designPath = false,
  onPreview,
  onSaved,
  onSavingChange,
  client = workspaceGitReviewClient,
}: MergeConflictActionsProps) {
  const [baseline, setBaseline] = useState(content);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const flight = useRef(false);
  const mounted = useRef(true);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const parsed = useMemo(() => parseMergeConflicts(baseline), [baseline]);
  const preview = useMemo(
    () =>
      parsed.errors.length
        ? { content: baseline, remaining: parsed.conflicts.length }
        : applyConflictChoices(baseline, choices),
    [baseline, choices, parsed],
  );
  const dirty = Object.keys(choices).length > 0;
  const stale = content !== baseline;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active || busy || content === baseline || (dirty && !saved)) return;
    setBaseline(content);
    setChoices({});
    setError(null);
    setSaved(false);
  }, [active, baseline, busy, content, dirty, saved]);

  function choose(id: string, choice: ConflictChoice) {
    if (!active || readOnly || designPath || busy || saved || !isGitConflict)
      return;
    const next = { ...choices, [id]: choice };
    const nextPreview = applyConflictChoices(baseline, next);
    setChoices(next);
    setError(null);
    onPreview(nextPreview.content);
  }
  async function save() {
    if (
      flight.current ||
      !active ||
      readOnly ||
      designPath ||
      !isGitConflict ||
      saved ||
      preview.remaining ||
      parsed.errors.length ||
      !dirty
    )
      return;
    flight.current = true;
    onSavingChange?.(true);
    setBusy(true);
    setError(null);
    try {
      await client.resolveConflict(cwd, {
        path,
        expectedContent: baseline,
        content: preview.content,
        choices,
      });
      if (!mounted.current) return;
      setSaved(true);
      onSaved(preview.content);
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error
            ? error.message
            : "The resolution could not be saved. Your preview is kept.",
        );
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
      onSavingChange?.(false);
    }
  }
  function reload() {
    setBaseline(content);
    setChoices({});
    setError(null);
    setSaved(false);
    setConfirmReload(false);
    onPreview(content);
  }

  if (
    !active ||
    (!parsed.conflicts.length && !parsed.errors.length) ||
    !isGitConflict
  )
    return null;
  if (readOnly || designPath)
    return (
      <p className="text-fg2 px-2 py-1 text-xs">
        {designPath
          ? "Resolve Design conflicts in Design view."
          : "Open the live editable file to resolve these conflicts."}
      </p>
    );
  return (
    <section
      aria-label="Merge conflict resolution"
      className="border-border1 bg-bg1 text-fg2 flex shrink-0 flex-col gap-1 border-b p-2 text-xs"
      data-conflict-dirty={dirty}
      data-conflict-stale={stale}
    >
      <div className="flex items-center gap-2">
        <span className="text-fg1 font-medium">Resolve conflicts</span>
        <span role="status">
          {saved ? "Resolution saved" : `${preview.remaining} remaining`}
        </span>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={
            busy ||
            saved ||
            !!preview.remaining ||
            !!parsed.errors.length ||
            !dirty
          }
          aria-busy={busy}
          onClick={() => void save()}
        >
          Save resolution
        </Button>
      </div>
      {parsed.errors.length ? (
        <p role="alert" className="text-red-primary">
          Line {parsed.errors[0].line}: {parsed.errors[0].message}
        </p>
      ) : (
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {parsed.conflicts.map((conflict, index) => (
            <div
              key={conflict.id}
              className="flex flex-wrap items-center gap-1"
              data-conflict-id={conflict.id}
            >
              <span className="mr-auto pr-2">Conflict {index + 1}</span>
              {(["current", "incoming", "both"] as const).map((choice) => (
                <Button
                  key={choice}
                  type="button"
                  size="sm"
                  variant={
                    choices[conflict.id] === choice ? "secondary-on" : "ghost"
                  }
                  aria-pressed={choices[conflict.id] === choice}
                  disabled={busy || saved}
                  title={
                    choice === "current"
                      ? conflict.currentLabel || "Current change"
                      : choice === "incoming"
                        ? conflict.incomingLabel || "Incoming change"
                        : "Current followed by incoming"
                  }
                  onClick={() => choose(conflict.id, choice)}
                >
                  {choice === "current"
                    ? "Current"
                    : choice === "incoming"
                      ? "Incoming"
                      : "Both"}
                </Button>
              ))}
            </div>
          ))}
        </div>
      )}
      {stale && !saved && (
        <div className="flex items-center gap-2">
          <span role="status">The file changed. Your preview is kept.</span>
          <Button
            ref={reloadButton}
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => (dirty ? setConfirmReload(true) : reload())}
          >
            Reload latest
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-red-primary">
          {error}
        </p>
      )}
      <Dialog open={active && confirmReload} onOpenChange={setConfirmReload}>
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (active) reloadButton.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Reload this file?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              Discard this resolution preview and load the latest content of{" "}
              <span className="text-fg1 break-all">{path}</span>.
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button
              ref={cancelButton}
              type="button"
              variant="ghost"
              onClick={() => setConfirmReload(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={reload}>
              Reload latest
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
