// Development-only browser coverage for the real shared overlays and file tree.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
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
import { WorkspaceFileTree } from "../shell/workbench/tabs/workspace-file-tree";
import { primeWorkspaceFiles } from "../shell/workspace-files-cache";

const cwd = "/overlay-positioning-fixture";
primeWorkspaceFiles(
  cwd,
  Array.from(
    { length: 60 },
    (_, index) => `file-${String(index).padStart(2, "0")}.ts`,
  ),
);

function Harness() {
  const [active, setActive] = useState(true);
  const [result, setResult] = useState("");
  const [large, setLarge] = useState(false);
  return (
    <main className="bg-bg1 text-fg1 min-h-screen">
      <button onClick={() => setActive((value) => !value)}>Toggle owner</button>
      <button onClick={() => setLarge((value) => !value)}>
        Toggle large menus
      </button>
      <output data-testid="result">{result}</output>
      <section
        data-testid="moving-host"
        className="absolute top-32 left-80 w-72"
        hidden={!active}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button data-testid="context-trigger">Context actions</button>
          </ContextMenuTrigger>
          <ContextMenuContent
            data-testid="context-content"
            className={large ? "w-[1200px]" : undefined}
          >
            <ContextMenuItem onSelect={() => setResult("context")}>
              Context action
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Context submenu</ContextMenuSubTrigger>
              <ContextMenuSubContent data-testid="context-submenu">
                <ContextMenuItem onSelect={() => setResult("context-sub")}>
                  Nested action
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            {large &&
              Array.from({ length: 60 }, (_, index) => (
                <ContextMenuItem key={index}>
                  Context item {index}
                </ContextMenuItem>
              ))}
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="dropdown-trigger">
            Dropdown actions
          </DropdownMenuTrigger>
          <DropdownMenuContent
            data-testid="dropdown-content"
            className={large ? "w-[1200px]" : undefined}
          >
            <DropdownMenuItem onSelect={() => setResult("dropdown")}>
              Dropdown action
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Dropdown submenu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent data-testid="dropdown-submenu">
                <DropdownMenuItem>Nested action</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {large &&
              Array.from({ length: 60 }, (_, index) => (
                <DropdownMenuItem key={index}>
                  Dropdown item {index}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger data-testid="popover-trigger">
            Popover actions
          </PopoverTrigger>
          <PopoverContent
            data-testid="popover-content"
            className={large ? "w-[1200px]" : undefined}
          >
            <button onClick={() => setResult("popover")}>Popover action</button>
            {large &&
              Array.from({ length: 60 }, (_, index) => (
                <p key={index}>Popover row {index}</p>
              ))}
          </PopoverContent>
        </Popover>
        <Select defaultValue="one">
          <SelectTrigger data-testid="select-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            data-testid="select-content"
            className={large ? "w-[1200px]" : undefined}
          >
            <SelectItem value="one">One</SelectItem>
            <SelectItem value="two">Two</SelectItem>
          </SelectContent>
        </Select>
        <div data-testid="tree-host" className="h-64 overflow-hidden">
          <WorkspaceFileTree
            active={active}
            cwd={cwd}
            onOpenFile={() => {}}
            onOpenInNewTab={(path) => setResult(`open:${path}`)}
            onCopyPath={(path) => setResult(`copy:${path}`)}
          />
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
