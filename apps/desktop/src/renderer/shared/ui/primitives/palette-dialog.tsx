import type { ComponentProps, RefObject } from "react";
import { cn } from "../cn";
import { Command } from "./command";
import { Button } from "./button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";

/** Search-first glass chrome shared by the command and shortcut palettes. */
export function PaletteDialog({
  title,
  description,
  children,
  className,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof Dialog> & {
  title: string;
  description: string;
  className?: string;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        dismissable
        showCloseButton={false}
        aria-label={title}
        onCloseAutoFocus={onCloseAutoFocus}
        className={cn(
          // Fixed geometry keeps category switches from moving the search field.
          "z-modal border-border2/60 fixed top-1/2 left-1/2 flex h-[min(72vh,432px)] w-[92vw] max-w-[660px] -translate-x-1/2 -translate-y-1/2 flex-col gap-0 overflow-hidden border p-0 shadow-[var(--shadow-dropdown)]",
          // 14px corners, including the shared dialog's responsive breakpoint.
          "rounded-[calc(var(--radius-lg)+var(--radius-md))] sm:rounded-[calc(var(--radius-lg)+var(--radius-md))]",
          "bg-bg2/30 backdrop-blur-[28px] backdrop-saturate-[1.2]",
          // Translate and zoom stay separate so the panel remains centered.
          "origin-center duration-200 ease-out data-[state=closed]:duration-150 data-[state=closed]:ease-in",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-97 data-[state=closed]:zoom-out-97",
          className,
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <DialogBody className="flex-1 gap-0 p-0">{children}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function PaletteCommand({
  className,
  ...props
}: ComponentProps<typeof Command>) {
  return (
    <Command
      {...props}
      className={cn(
        // Tint the separator against composited glass, including Light's scrim.
        "**:data-[slot=command-input-wrapper]:border-fg1/15 min-h-0 bg-transparent **:data-[slot=command-input-wrapper]:h-12 **:data-[slot=command-input-wrapper]:shrink-0",
        className,
      )}
    />
  );
}

/** Browsing categories with a pointer keeps a search-first palette ready to
 * type. Tab/Enter/Space keep the user's explicit keyboard focus on the button. */
export function PaletteCategoryButton({
  searchRef,
  onPointerDown,
  onClick,
  onKeyDown,
  ...props
}: ComponentProps<typeof Button> & {
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <Button
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.button === 0 && !event.ctrlKey) event.preventDefault();
      }}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && event.detail > 0) {
          searchRef.current?.focus({ preventScroll: true });
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        // cmdk must not activate a result when Enter activates this category.
        if (event.key === "Enter") event.stopPropagation();
      }}
    />
  );
}
