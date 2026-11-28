// ============================================
// COMPONENT: SidebarGroupOrderList
// PURPOSE: The Group menu's list of the current grouping's groups: drag a
//          group by its handle (or Alt+↑ / Alt+↓) to reorder it, choose the
//          row (or its eye) to hide or show it.
// USED IN: SidebarWorkspaceMenu (sidebar-workspace-menu.tsx)
// ============================================
//
// The rows are ordinary menu items, so the menu's keyboard navigation and
// focus keep working; choosing one never closes the menu. A hidden group keeps
// its count, so the user can see what the eye takes out of view.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Eye, EyeOff, GripVertical } from "lucide-react";

import { cn } from "../shared/ui/cn";
import { DropdownMenuItem } from "../shared/ui/primitives/dropdown-menu";

export interface SidebarGroupOrderItem {
  key: string;
  label: string;
  count?: number;
}

/** The order after moving `key` to `to` (an index in the current order). */
export function moveSidebarGroup(keys: readonly string[], key: string, to: number): string[] {
  const from = keys.indexOf(key);
  if (from < 0) return [...keys];
  const next = keys.filter((entry) => entry !== key);
  const target = Math.max(0, Math.min(next.length, to > from ? to - 1 : to));
  next.splice(target, 0, key);
  return next;
}

export function SidebarGroupOrderList({
  items,
  hidden,
  onReorder,
  onToggleHidden,
}: {
  items: readonly SidebarGroupOrderItem[];
  hidden: readonly string[];
  onReorder: (keys: string[]) => void;
  onToggleHidden: (key: string, hidden: boolean) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ key: string; to: number } | null>(null);
  const keys = items.map((item) => item.key);

  const dropIndexAt = (clientY: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-group-order]") ?? [];
    let index = rows.length;
    for (const [position, row] of [...rows].entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        index = position;
        break;
      }
    }
    return index;
  };
  const startDrag = (key: string, event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ key, to: keys.indexOf(key) });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!drag) return;
    const to = dropIndexAt(event.clientY);
    if (to !== drag.to) setDrag({ ...drag, to });
  };
  const endDrag = () => {
    if (!drag) return;
    const next = moveSidebarGroup(keys, drag.key, drag.to);
    setDrag(null);
    if (next.some((key, index) => key !== keys[index])) onReorder(next);
  };

  return (
    <div ref={listRef} role="group" aria-label="Groups" data-sidebar-group-order-list="">
      {items.map((item, index) => {
        const isHidden = hidden.includes(item.key);
        return (
          <div key={item.key}>
            {drag && drag.to === index && drag.key !== item.key && (
              <div className="bg-accent mx-2 h-0.5 rounded-full" aria-hidden="true" data-sidebar-group-drop="" />
            )}
            <DropdownMenuItem
              role="menuitemcheckbox"
              aria-checked={!isHidden}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              className={cn(isHidden && "text-fg3")}
              data-sidebar-group-order={item.key}
              onSelect={(event) => {
                event.preventDefault();
                onToggleHidden(item.key, !isHidden);
              }}
              onKeyDown={(event) => {
                if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                event.preventDefault();
                event.stopPropagation();
                const to = event.key === "ArrowUp" ? index - 1 : index + 2;
                if (to < 0 || to > items.length) return;
                onReorder(moveSidebarGroup(keys, item.key, to));
                // Keep focus on the group that moved, whichever rows React
                // re-inserts, so repeated Alt+↑/↓ keeps moving the same one.
                const moved = item.key;
                requestAnimationFrame(() => {
                  listRef.current
                    ?.querySelector<HTMLElement>(`[data-sidebar-group-order="${CSS.escape(moved)}"]`)
                    ?.focus();
                });
              }}
            >
              <span
                className="text-fg3 -ml-1 inline-flex size-4 shrink-0 cursor-grab items-center justify-center touch-none active:cursor-grabbing"
                aria-hidden="true"
                data-sidebar-group-grip=""
                onPointerDown={(event) => startDrag(item.key, event)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={() => setDrag(null)}
              >
                <GripVertical strokeWidth={1.5} className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.count != null && <span className="text-fg3 ml-3 shrink-0 text-3xxs tabular-nums">{item.count}</span>}
              <span className="text-fg3 ml-1 inline-flex shrink-0" aria-hidden="true">
                {isHidden ? <EyeOff strokeWidth={1.5} className="size-3.5" /> : <Eye strokeWidth={1.5} className="size-3.5" />}
              </span>
            </DropdownMenuItem>
          </div>
        );
      })}
      {drag && drag.to === items.length && (
        <div className="bg-accent mx-2 h-0.5 rounded-full" aria-hidden="true" data-sidebar-group-drop="" />
      )}
    </div>
  );
}
