// PURPOSE: The Style panel's overlay API for its fields: the one token
// picker and Reset, reached through context. No components here, so fields
// and the overlays that serve them can both import it.

import { createContext, useContext } from "react";

import type { DesignTokenType } from "./design-token-catalog";
import type { DesignTokenListGroup } from "./design-token-picker";

/** A picker request from a control that is not an ordinary style field, such
 * as Typography's Style row. */
export interface DesignPickerRequest {
  field: HTMLElement;
  label: string;
  accepts: readonly DesignTokenType[];
  rows?: readonly DesignTokenListGroup[];
  kind?: string;
  activeName: string | null;
  onChoose: (name: string) => void;
  /** The control focus goes back to; it toggles the picker closed. */
  trigger?: HTMLElement | null;
}

export interface DesignFieldOverlaysApi {
  openPicker(request: DesignPickerRequest): void;
  /** Opens the picker for a style field from its own attributes; false
   * when the field takes no tokens the frame offers. */
  openPickerForField(field: HTMLElement, trigger?: HTMLElement | null): boolean;
  /** Reset for the field the element belongs to (Alt+Backspace). A text
   * input calls it after dropping its draft, so blur cannot write it back. */
  resetField(element: HTMLElement): void;
  /** Alt+Down and Alt+Backspace on a field. The panel listens itself; a
   * portaled surface (Type settings) forwards its key events here. */
  fieldShortcut(event: DesignFieldShortcutEvent): void;
}

export interface DesignFieldShortcutEvent {
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

const NO_OVERLAYS: DesignFieldOverlaysApi = {
  openPicker: () => {},
  openPickerForField: () => false,
  resetField: () => {},
  fieldShortcut: () => {},
};

export const DesignFieldOverlaysContext = createContext<DesignFieldOverlaysApi>(NO_OVERLAYS);

export function useDesignFieldOverlays(): DesignFieldOverlaysApi {
  return useContext(DesignFieldOverlaysContext);
}

/** Alt+Backspace deletes a word in a text input. It resets the field only
 * when there is no word under the caret to delete: the whole value is
 * selected, as after tabbing in, or the input is empty. */
export function designInputResetsOnAltBackspace(
  input: Pick<HTMLInputElement, "value" | "selectionStart" | "selectionEnd">,
): boolean {
  const length = input.value.length;
  return length === 0 || (input.selectionStart === 0 && input.selectionEnd === length);
}
