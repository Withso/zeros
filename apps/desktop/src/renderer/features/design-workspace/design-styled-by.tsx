// PURPOSE: The Styled-by line under the Style panel's header: which classes,
// utilities and component style the layer, and what changed on it. A row
// narrows the panel to the properties that source sets.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button, ListRow } from "../../shared/ui/primitives";
import type { DesignStyledBy, DesignStyledByGroup } from "./design-style-origins";

/** What the filter note says the properties are: from a source, whose name
 * keeps to one line, or changed here. */
function filterNote(group: DesignStyledByGroup): { lead: string; name?: string } {
  if (group.kind === "changed") return { lead: "changed here" };
  if (group.kind === "utility") return { lead: "from utilities" };
  return { lead: "from", name: group.name };
}

export function DesignStyledByLine({
  styledBy,
  filter,
  onFilter,
}: {
  styledBy: DesignStyledBy;
  filter: DesignStyledByGroup | null;
  onFilter: (key: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = filter?.properties.length ?? 0;
  const note = filter ? filterNote(filter) : null;
  return (
    <div data-design-styled-by="">
      <ListRow
        variant="panel"
        aria-label="What styles this layer"
        aria-expanded={open}
        className={open ? "text-fg2" : "border-border1 text-fg3 border-b"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 flex-1 truncate" data-design-styled-by-summary="">
          {styledBy.summary}
        </span>
        {open ? (
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
        )}
      </ListRow>
      {open ? (
        <div className="border-border1 flex flex-col gap-px border-b px-1.5 pb-2" role="group" aria-label="Sources">
          {styledBy.groups.map((group) => {
            const on = filter?.key === group.key;
            return (
              <ListRow
                key={group.key}
                variant="panel"
                size="sm"
                aria-pressed={on}
                data-design-styled-by-source={group.key}
                className="text-fg2 grid grid-cols-[84px_minmax(0,1fr)_auto]"
                onClick={() => onFilter(on ? null : group.key)}
              >
                <span className="text-fg3 truncate">{group.label}</span>
                <span className="truncate">{group.name}</span>
                <span
                  className="text-fg3 text-2xxs tabular-nums"
                  aria-label={`${group.properties.length} ${group.properties.length === 1 ? "property" : "properties"}`}
                >
                  {group.properties.length}
                </span>
              </ListRow>
            );
          })}
        </div>
      ) : null}
      {filter && note ? (
        <div className="border-border1 text-fg3 flex min-h-7 items-center gap-2 border-b py-0.5 pr-2 pl-3 text-3xxs leading-4">
          <span className="min-w-0 flex-1" data-design-styled-by-note="">
            Showing{" "}
            <b className="text-fg2 font-medium">
              {count} {count === 1 ? "property" : "properties"}
            </b>{" "}
            {note.lead}
            {note.name ? (
              <>
                {" "}
                {/* A class name wraps whole or truncates, never mid-name. */}
                <span className="inline-block max-w-full truncate align-bottom whitespace-nowrap">
                  {note.name}
                </span>
              </>
            ) : null}
          </span>
          <Button type="button" variant="ghost" size="compact" className="text-fg2" onClick={() => onFilter(null)}>
            Show all
          </Button>
        </div>
      ) : null}
    </div>
  );
}
