import { useId, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, ShieldCheck } from "lucide-react";
import { Input } from "../../shared/ui/primitives/input";
import { Button } from "../../shared/ui/primitives/button";
import { Switch } from "../../shared/ui/primitives/switch";
import { ZerosSpinner } from "../../shared/ui/loading";

const PAGE_SIZE = 50;

/** Discovery is separate from the saved policy: unavailable tools keep their
 * restrictions, and refreshing never writes configuration. */
export function McpToolsSection({ tools, disabledTools, controlled, editable, checking, actionsDisabled, emptyHint, onChange, onTest, onRefresh }: {
  tools?: readonly string[];
  disabledTools: readonly string[];
  controlled: boolean;
  editable: boolean;
  checking: boolean;
  actionsDisabled: boolean;
  emptyHint: string;
  onChange: (disabled: string[]) => void;
  onTest: () => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const names = useMemo(() => tools === undefined ? undefined : [...new Set(tools)], [tools]);
  const disabled = useMemo(() => new Set(disabledTools), [disabledTools]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return names?.filter(name => name.toLocaleLowerCase().includes(query)) ?? [];
  }, [names, search]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * PAGE_SIZE;
  const hint = !controlled ? "This connection does not support changing individual tool access."
    : !editable ? "Tool access is managed by the server’s owner."
      : "Enable or disable individual tools. Changes apply when you save.";
  return <section aria-label="Tools" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2"><h2 className="text-fg1 m-0 text-sm font-medium">Tools</h2>
          <span className="text-fg3 flex items-center gap-1.5 text-xs" role="status" aria-live="polite">
            {checking && <ZerosSpinner className="size-3.5" />}
            {checking ? "Refreshing…" : names === undefined ? "Not listed yet" : `${names.length} listed`}
          </span>
        </div>
        {names !== undefined && names.length > 0 && <p className="text-fg3 m-0 text-xs leading-relaxed">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" disabled={actionsDisabled || checking} onClick={onTest}><ShieldCheck aria-hidden="true" />Test</Button>
        <Button variant="ghost" disabled={actionsDisabled || checking} onClick={onRefresh}><RefreshCw aria-hidden="true" />Refresh</Button>
      </div>
    </div>
    {names !== undefined && names.length > 0 && (names.length > PAGE_SIZE || search.length > 0) && <Input aria-label="Search tools" placeholder="Search tools…" value={search}
      onChange={event => { setSearch(event.target.value); setPage(0); }} className="text-fg1 font-sans" autoComplete="off" spellCheck={false} />}
    <div className="border-border1 bg-bg1-highlight divide-border1 flex max-h-80 flex-col divide-y overflow-y-auto rounded-lg border px-4">
      {names === undefined ? <p className="text-fg3 m-0 py-6 text-center text-sm">{emptyHint}</p>
        : names.length === 0 ? <p className="text-fg3 m-0 py-6 text-center text-sm">This server has no tools.</p>
          : filtered.length === 0 ? <p className="text-fg3 m-0 py-6 text-center text-sm">No tools match your search.</p>
            : filtered.slice(start, start + PAGE_SIZE).map((name, index) => <div key={name} className="flex min-w-0 items-center justify-between gap-4 py-3">
              <label htmlFor={`${id}-${index}`} title={name} className="text-fg1 min-w-0 flex-1 truncate text-sm font-normal">{name}</label>
              <Switch id={`${id}-${index}`} aria-label={`Allow ${name}`} checked={!controlled || !disabled.has(name)} disabled={!controlled || !editable}
                onCheckedChange={allowed => {
                  const next = new Set(disabledTools);
                  if (allowed) next.delete(name); else next.add(name);
                  onChange([...next]);
                }} />
            </div>)}
    </div>
    {filtered.length > PAGE_SIZE && <div className="text-fg3 flex items-center justify-between gap-3 text-xs">
      <span>{start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="compact" aria-label="Previous tools" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft aria-hidden="true" />Previous</Button>
        <Button variant="ghost" size="compact" aria-label="Next tools" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next<ChevronRight aria-hidden="true" /></Button>
      </div>
    </div>}
  </section>;
}
