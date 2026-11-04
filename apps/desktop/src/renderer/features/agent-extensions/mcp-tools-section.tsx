import { useId, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Input } from "../../shared/ui/primitives/input";
import { Button } from "../../shared/ui/primitives/button";
import { Switch } from "../../shared/ui/primitives/switch";
import { SettingsList } from "../settings/settings-ui";

const PAGE_SIZE = 50;

/** Discovery is separate from the saved policy: unavailable tools keep their
 * restrictions, and refreshing never writes configuration. */
export function McpToolsSection({ tools, disabledTools, controlled, editable, checking, actionsDisabled, emptyHint, onChange, onRefresh }: {
  tools?: readonly string[];
  disabledTools: readonly string[];
  controlled: boolean;
  editable: boolean;
  checking: boolean;
  actionsDisabled: boolean;
  emptyHint: string;
  onChange: (disabled: string[]) => void;
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
  // The count and what a change does share one line.
  const summary = checking ? "Refreshing…" : names === undefined ? "Not listed yet"
    : `${names.length} ${names.length === 1 ? "tool" : "tools"} · ${!controlled ? "Access can’t be changed here."
      : !editable ? "Managed by the server’s owner." : "Changes apply when you save."}`;
  return <section aria-label="Tools" className="flex min-w-0 flex-col gap-2">
    <div className="flex items-end justify-between gap-4 px-0.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-fg1 m-0 text-xs leading-4.5 font-medium">Tools</h2>
        <p className="text-fg3 m-0 text-3xxs leading-4" role="status" aria-live="polite">{summary}</p>
      </div>
      {names !== undefined && <Button variant="ghost" size="compact" className="text-fg2 shrink-0" loading={checking}
        disabled={actionsDisabled} onClick={onRefresh}><RefreshCw aria-hidden="true" />Refresh</Button>}
    </div>
    {names !== undefined && names.length > 0 && (names.length > PAGE_SIZE || search.length > 0) && <Input aria-label="Search tools" placeholder="Search tools…" value={search}
      onChange={event => { setSearch(event.target.value); setPage(0); }} autoComplete="off" spellCheck={false} />}
    <SettingsList className="max-h-80 overflow-y-auto">
      {names === undefined ? <p className="text-fg2 m-0 text-xs leading-4.5">{emptyHint}</p>
        : names.length === 0 ? <p className="text-fg2 m-0 text-xs leading-4.5">This server has no tools.</p>
          : filtered.length === 0 ? <p className="text-fg2 m-0 text-xs leading-4.5">No tools match your search.</p>
            // The server list's tool rows: 32px sans, off tools in fg3, no dividers.
            : <div role="group" aria-label="Tool access" className="flex min-w-0 flex-col">
              {filtered.slice(start, start + PAGE_SIZE).map((name, index) => {
                const allowed = !controlled || !disabled.has(name);
                return <div key={name} className="flex h-8 min-w-0 items-center justify-between gap-4">
                  <label htmlFor={`${id}-${index}`} title={name} className={`min-w-0 flex-1 truncate text-xs leading-4.5 font-normal ${allowed ? "text-fg2" : "text-fg3"}`}>{name}</label>
                  <Switch id={`${id}-${index}`} aria-label={`Allow ${name}`} checked={allowed} disabled={!controlled || !editable}
                    onCheckedChange={next => {
                      const set = new Set(disabledTools);
                      if (next) set.delete(name); else set.add(name);
                      onChange([...set]);
                    }} />
                </div>;
              })}
            </div>}
    </SettingsList>
    {filtered.length > PAGE_SIZE && <div className="text-fg3 flex items-center justify-between gap-3 text-xs">
      <span>{start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="compact" aria-label="Previous tools" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft aria-hidden="true" />Previous</Button>
        <Button variant="ghost" size="compact" aria-label="Next tools" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next<ChevronRight aria-hidden="true" /></Button>
      </div>
    </div>}
  </section>;
}
