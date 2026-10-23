// Browser-only fixture: a closing owner can hide or replace its anchor in the
// same commit (hover-only sidebar actions and retained workspace composers).
import React, { useEffect, useRef, useState } from "react";
import { listenForNativeSurfaceOverlayIntent } from "../shared/ui/native-surface-overlay";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../shared/ui/primitives/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../shared/ui/primitives/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../shared/ui/primitives/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../shared/ui/primitives/select";
import {
  TooltipContent,
  TooltipRoot,
  TooltipTrigger,
} from "../shared/ui/primitives/tooltip";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../shared/ui/primitives/hover-card";

const owners = ["personal-local", "organization-local", "organization-cloud"];

export function OverlayDismissalFixture() {
  const query = new URLSearchParams(location.search);
  const kind = query.get("kind") ?? "dropdown";
  const [owner, setOwner] = useState(query.get("owner") ?? owners[0]);
  const [open, setOpen] = useState(false);
  const [hideAnchor, setHideAnchor] = useState(false);
  const [selections, setSelections] = useState(0);
  const [nativeOverlayActive, setNativeOverlayActive] = useState(false);
  const [focusEscapes, setFocusEscapes] = useState(0);
  const escapedOnFocus = useRef(false);
  useEffect(
    () => listenForNativeSurfaceOverlayIntent(setNativeOverlayActive),
    [],
  );
  const escapeOnFirstFocus = query.has("escape-on-focus")
    ? (event: React.FocusEvent<HTMLElement>) => {
        if (escapedOnFocus.current) return;
        escapedOnFocus.current = true;
        setFocusEscapes((count) => count + 1);
        // Radix has focused content, but its document Escape listener may not
        // have mounted yet. Reproduce that exact boundary without a sleep.
        event.target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    : undefined;
  const choose = () => {
    setSelections((count) => count + 1);
    setOpen(false);
  };
  const anchorHidden = hideAnchor && !open;
  let popup: React.ReactNode;

  if (kind === "dropdown" || kind === "context") {
    const Root = kind === "dropdown" ? DropdownMenu : ContextMenu;
    const Trigger =
      kind === "dropdown" ? DropdownMenuTrigger : ContextMenuTrigger;
    const Content =
      kind === "dropdown" ? DropdownMenuContent : ContextMenuContent;
    const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
    const Sub = kind === "dropdown" ? DropdownMenuSub : ContextMenuSub;
    const SubTrigger =
      kind === "dropdown" ? DropdownMenuSubTrigger : ContextMenuSubTrigger;
    const SubContent =
      kind === "dropdown" ? DropdownMenuSubContent : ContextMenuSubContent;
    popup = (
      <Root open={open} onOpenChange={setOpen}>
        <span hidden={anchorHidden}>
          <Trigger asChild>
            <button data-testid="dismissal-trigger">{owner} actions</button>
          </Trigger>
        </span>
        <Content data-testid="dismissal-content" onFocus={escapeOnFirstFocus}>
          <Item onSelect={choose}>Choose option</Item>
          <Sub>
            <SubTrigger>Nested options</SubTrigger>
            <SubContent data-testid="dismissal-submenu">
              <Item onSelect={choose}>Choose nested option</Item>
            </SubContent>
          </Sub>
        </Content>
      </Root>
    );
  } else if (kind === "popover") {
    popup = (
      <Popover open={open} onOpenChange={setOpen}>
        <span hidden={anchorHidden}>
          <PopoverTrigger data-testid="dismissal-trigger">
            {owner} options
          </PopoverTrigger>
        </span>
        <PopoverContent
          data-testid="dismissal-content"
          onFocus={escapeOnFirstFocus}
        >
          <button onClick={choose}>Choose option</button>
          <Popover>
            <PopoverTrigger>Nested options</PopoverTrigger>
            <PopoverContent data-testid="dismissal-submenu">
              <button onClick={choose}>Choose nested option</button>
            </PopoverContent>
          </Popover>
        </PopoverContent>
      </Popover>
    );
  } else if (kind === "select") {
    popup = (
      <Select
        open={open}
        onOpenChange={setOpen}
        defaultValue="one"
        onValueChange={choose}
      >
        <span hidden={anchorHidden}>
          <SelectTrigger data-testid="dismissal-trigger">
            <SelectValue />
          </SelectTrigger>
        </span>
        <SelectContent data-testid="dismissal-content">
          <SelectItem value="one">Current option</SelectItem>
          <SelectItem value="two">Choose option</SelectItem>
        </SelectContent>
      </Select>
    );
  } else if (kind === "tooltip") {
    popup = (
      <TooltipRoot open={open} onOpenChange={setOpen} delayDuration={0}>
        <span hidden={anchorHidden}>
          <TooltipTrigger data-testid="dismissal-trigger">
            {owner} help
          </TooltipTrigger>
        </span>
        <TooltipContent data-testid="dismissal-content">
          Workspace help
        </TooltipContent>
      </TooltipRoot>
    );
  } else {
    popup = (
      <HoverCard
        open={open}
        onOpenChange={setOpen}
        openDelay={0}
        closeDelay={0}
      >
        <span hidden={anchorHidden}>
          <HoverCardTrigger asChild>
            <button data-testid="dismissal-trigger">{owner} preview</button>
          </HoverCardTrigger>
        </span>
        <HoverCardContent data-testid="dismissal-content">
          Workspace preview
        </HoverCardContent>
      </HoverCard>
    );
  }

  return (
    <main
      className="bg-bg1 text-fg1 min-h-screen"
      data-testid="dismissal-owner"
      data-owner={owner}
    >
      <button data-testid="outside-target">Outside target</button>
      <button
        data-testid="hide-anchor"
        onClick={() => setHideAnchor((value) => !value)}
      >
        Toggle anchor retirement
      </button>
      <button
        data-testid="switch-owner"
        onClick={() => {
          setOpen(false);
          setOwner(owners[(owners.indexOf(owner) + 1) % owners.length]);
        }}
      >
        Switch owner
      </button>
      <output data-testid="selection-count">{selections}</output>
      <output data-testid="native-overlay-active">
        {String(nativeOverlayActive)}
      </output>
      <output data-testid="focus-escapes">{focusEscapes}</output>
      <section className="absolute top-80 left-80">{popup}</section>
    </main>
  );
}
