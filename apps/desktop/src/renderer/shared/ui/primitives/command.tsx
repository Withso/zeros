"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import {
  MENU_ITEM_BOX,
  MENU_ITEM_RADIUS,
  MENU_SEPARATOR,
  MENU_SURFACE_INSET,
  MENU_SURFACE_RADIUS,
} from "@/renderer/shared/ui/menu-surface";
import { KbdKeys } from "@/renderer/shared/ui/primitives/kbd";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/renderer/shared/ui/primitives/dialog";

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-bg3 text-fg1 flex h-full w-full flex-col overflow-hidden",
        MENU_SURFACE_RADIUS,
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  shouldFilter,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  /** Forwarded to <Command>. Pass false when the caller owns filtering —
   *  cmdk's built-in filter SORTS BY SCORE, which silently re-orders a list
   *  whose order is itself meaningful (e.g. newest-first). */
  shouldFilter?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn("gap-0 overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
        onOpenAutoFocus={(event) => {
          // Keep typing ready in the search field ahead of the header's close.
          const input = (event.target as HTMLElement).querySelector<HTMLInputElement>(
            '[data-slot="command-input"]:not(:disabled)',
          );
          if (input) {
            event.preventDefault();
            input.focus();
          }
        }}
        // A command palette is a transient surface — click-away IS the
        // expected close, so opt back into outside-dismiss (the Dialog
        // default is now modal/no-overlay-dismiss).
        dismissable
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-0">
          <Command
            shouldFilter={shouldFilter}
            // The dialog's one larger row: 36 tall with 16px icons, under a
            // 44px search field.
            className="**:data-[slot=command-input-wrapper]:h-11 **:data-[slot=command-input-wrapper]:px-4 **:data-[slot=command-input]:text-sm [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[data-slot=command-input-wrapper]_svg]:size-4 [&_[cmdk-item]]:min-h-9 [&_[cmdk-item]]:py-2 [&_[cmdk-item]_svg]:size-4"
          >
            {children}
          </Command>
          <div
            data-slot="command-footer"
            className="border-border2 text-fg3 text-3xxs flex items-center gap-3 border-t px-3 py-2 leading-4"
          >
            <span className="inline-flex items-center gap-1">
              <KbdKeys keys="↑↓" />
              Navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <KbdKeys keys="↵" />
              Open
            </span>
            <span className="inline-flex items-center gap-1">
              <KbdKeys keys="esc" />
              Close
            </span>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  showSearchIcon = true,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** Keep command-search spacing while allowing iconless embedded pickers. */
  showSearchIcon?: boolean;
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="border-border2 flex h-9 items-center gap-2 border-b px-3"
    >
      {showSearchIcon && <SearchIcon className="text-muted-fg size-3.5 shrink-0" />}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          // Fills the row its wrapper sets (36px, 44 in the dialog) instead
          // of a fixed 40px that overflowed the 36px row.
          "placeholder:text-fg3 flex h-full w-full min-w-0 rounded-sm bg-transparent py-0 text-xs outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[300px] scroll-py-1.5 overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-xs"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-fg1 [&_[cmdk-group-heading]]:text-fg3 overflow-hidden [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-3xxs [&_[cmdk-group-heading]]:leading-4 [&_[cmdk-group-heading]]:font-medium",
        MENU_SURFACE_INSET,
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn(MENU_SEPARATOR, className)}
      {...props}
    />
  );
}

const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => {
  return (
    <CommandPrimitive.Item
      ref={ref}
      data-slot="command-item"
      className={cn(
        "data-[selected=true]:bg-bg3-hover data-[selected=true]:text-fg1 data-[selected=true]:[&_.text-muted-fg]:text-fg3 [&_svg:not([class*='text-'])]:text-fg2 relative flex cursor-default items-center outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        MENU_ITEM_BOX,
        MENU_ITEM_RADIUS,
        className,
      )}
      {...props}
    />
  );
});
CommandItem.displayName = CommandPrimitive.Item.displayName;

/** A row's shortcut as Kbd chips, one per key, at the row's end. */
function CommandShortcut({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return typeof children === "string" ? (
    <KbdKeys data-slot="command-shortcut" keys={children} className={cn("ml-auto", className)} {...props} />
  ) : (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto inline-flex items-center gap-0.5", className)}
      {...props}
    >
      {children}
    </span>
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
