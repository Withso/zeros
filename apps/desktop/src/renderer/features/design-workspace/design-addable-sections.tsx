// ============================================
// MODULE: Addable inspector sections
// PURPOSE: Most empty Style sections are one row with a plus. Typography on
//          a layer that is not text, and Transform, draw nothing while
//          unused; the Add property menu lists them and, when chosen,
//          reveals one and runs that section's own add action.
// USED IN: DesignStyleEditor (provider and menu) and InspectorSection
// ============================================

import React from "react";
import { Plus } from "lucide-react";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives";

export type DesignAddableSectionId = "typography" | "transform";

/** The menu lists hidden sections in the inspector's own order. */
const ORDER: readonly DesignAddableSectionId[] = ["typography", "transform"];

export interface DesignAddableSection {
  id: DesignAddableSectionId;
  /** Runs the section's own add: commit a default, open its editor, … */
  onAdd: () => void;
}

interface HiddenSection {
  id: DesignAddableSectionId;
  title: string;
  add: () => void;
}

interface Registry {
  revealed: ReadonlySet<DesignAddableSectionId>;
  register: (section: HiddenSection) => () => void;
}

const RegistryContext = React.createContext<Registry | null>(null);

class HiddenSections {
  private sections = new Map<DesignAddableSectionId, HiddenSection>();
  private listeners = new Set<() => void>();
  private snapshot: readonly HiddenSection[] = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  register = (section: HiddenSection) => {
    this.sections.set(section.id, section);
    this.publish();
    return () => {
      if (this.sections.get(section.id) !== section) return;
      this.sections.delete(section.id);
      this.publish();
    };
  };

  private publish() {
    this.snapshot = ORDER.flatMap((id) => {
      const section = this.sections.get(id);
      return section ? [section] : [];
    });
    for (const listener of this.listeners) listener();
  }
}

interface ProviderValue {
  hidden: HiddenSections;
  reveal: (section: HiddenSection) => void;
}

const MenuContext = React.createContext<ProviderValue | null>(null);

/** Owns which empty sections are hidden or revealed for one selection; a new
 * `selectionKey` hides again whatever the last selection revealed. */
export function DesignAddableSections({
  selectionKey,
  children,
}: {
  selectionKey: string;
  children: React.ReactNode;
}) {
  const [hidden] = React.useState(() => new HiddenSections());
  const [revealed, setRevealed] = React.useState<{
    key: string;
    ids: ReadonlySet<DesignAddableSectionId>;
  }>({ key: selectionKey, ids: new Set() });
  const ids = revealed.key === selectionKey ? revealed.ids : EMPTY;
  const registry = React.useMemo<Registry>(
    () => ({ revealed: ids, register: hidden.register }),
    [ids, hidden],
  );
  const menu = React.useMemo<ProviderValue>(
    () => ({
      hidden,
      reveal: (section) => {
        setRevealed((current) => ({
          key: selectionKey,
          ids: new Set([
            ...(current.key === selectionKey ? current.ids : []),
            section.id,
          ]),
        }));
        // After the menu has closed and returned focus, so an editor the add
        // opens (Transform's popover, Typography's fields) keeps it.
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => section.add()),
        );
      },
    }),
    [hidden, selectionKey],
  );
  return (
    <RegistryContext.Provider value={registry}>
      <MenuContext.Provider value={menu}>{children}</MenuContext.Provider>
    </RegistryContext.Provider>
  );
}

const EMPTY: ReadonlySet<DesignAddableSectionId> = new Set();

/** True when `InspectorSection` should draw nothing: the section is empty,
 * addable, inside a provider and not revealed. While hidden it is listed in
 * the Add property menu under `title`. */
export function useDesignSectionHidden(
  addable: DesignAddableSection | undefined,
  empty: boolean,
  title: string,
): boolean {
  const registry = React.useContext(RegistryContext);
  const hidden =
    !!registry && !!addable && empty && !registry.revealed.has(addable.id);
  const onAdd = React.useRef(addable?.onAdd);
  onAdd.current = addable?.onAdd;
  const id = addable?.id;
  React.useLayoutEffect(() => {
    if (!hidden || !registry || !id) return;
    return registry.register({ id, title, add: () => onAdd.current?.() });
  }, [hidden, registry, id, title]);
  return hidden;
}

/** The one row that adds a hidden section; absent when none is hidden. */
export function DesignAddPropertyRow({ disabled }: { disabled?: boolean }) {
  const menu = React.useContext(MenuContext);
  const sections = React.useSyncExternalStore(
    menu?.hidden.subscribe ?? noopSubscribe,
    menu?.hidden.getSnapshot ?? emptySnapshot,
    menu?.hidden.getSnapshot ?? emptySnapshot,
  );
  if (!menu || sections.length === 0) return null;
  return (
    <section className="zd-section" data-design-add-property="">
      <div className="zd-add-property-row">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="compact"
              disabled={disabled}
              className="text-fg2 hover:text-fg1 data-[state=open]:text-fg1"
            >
              <Plus aria-hidden="true" />
              Add property
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-design-popover="">
            {sections.map((section) => (
              <DropdownMenuItem
                key={section.id}
                data-design-add-section={section.id}
                onSelect={() => menu.reveal(section)}
              >
                {section.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </section>
  );
}

const noopSubscribe = () => () => {};
const NO_SECTIONS: readonly HiddenSection[] = [];
const emptySnapshot = () => NO_SECTIONS;
