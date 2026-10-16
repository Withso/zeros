import {
  normalizeBrowserAppearance,
  type BrowserAppearance,
} from "@zeros/protocol/browser-tools";

import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/renderer/shared/ui/primitives";

const BROWSER_APPEARANCE_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** "Appearance" submenu shared by both Browser tab "..." menus. System is the
 * absence of a stored value: the page follows the Zeros appearance. */
export function BrowserAppearanceMenu({
  appearance,
  onAppearanceChange,
}: {
  appearance: BrowserAppearance | undefined;
  onAppearanceChange: (appearance: BrowserAppearance | undefined) => void;
}) {
  const current = appearance ?? "system";
  const currentLabel = BROWSER_APPEARANCE_OPTIONS.find(
    (option) => option.value === current,
  )?.label;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">Appearance</span>
        <span className="text-muted-fg">{currentLabel}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[140px]">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(value) => {
            const next = normalizeBrowserAppearance(value);
            if (next !== appearance) onAppearanceChange(next);
          }}
        >
          {BROWSER_APPEARANCE_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              indicator="check"
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
