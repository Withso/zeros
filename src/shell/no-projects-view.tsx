// ──────────────────────────────────────────────────────────
// NoProjectsView — full-window welcome shown when no projects exist
// ──────────────────────────────────────────────────────────
//
// Desktop, zero projects → replaces Column 2 + Column 3 below the global top
// bar. Centered Zeros mark over three big tiles that fire the same
// add-project flows as the Dispatcher folder menu (via AddProjectProvider):
// Open project / Open GitHub project / Quick start.
//
// The container is a window-drag region (the tiles are <button>s, so
// useCustomWindowDrag auto-excludes them) — it stands in for the column
// header strips this view replaces, so the window stays draggable.

import { useRef, type ComponentType } from "react";
import { FolderOpen, Sparkles } from "lucide-react";

import { GithubIcon } from "../zeros/ui";
import { Tile } from "../zeros/ui/primitives";
import { useCustomWindowDrag } from "./use-custom-window-drag";
import { useAddProject } from "./add-project-provider";
import zerosLogo from "../assets/zeros-logo.png";

interface StartTileProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  description: string;
  onClick: () => void;
}

function StartTile({
  icon: Icon,
  label,
  description,
  onClick,
}: StartTileProps) {
  return (
    <Tile
      onClick={onClick}
      className="group flex h-28 w-44 flex-col justify-between"
    >
      <Icon className="text-fg2 group-hover:text-fg1 size-5 stroke-[1] transition-colors" />
      <span className="flex flex-col gap-0.5">
        <span className="text-fg1 text-sm font-medium">{label}</span>
        <span className="text-fg2 text-xs">{description}</span>
      </span>
    </Tile>
  );
}

export function NoProjectsView() {
  const { openProject, openGithubProject, quickStart } = useAddProject();
  const dragRef = useRef<HTMLDivElement | null>(null);
  useCustomWindowDrag(dragRef);

  return (
    <div
      ref={dragRef}
      className="bg-bg1 relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-10 overflow-auto p-8"
    >
      <img
        src={zerosLogo}
        width={64}
        height={64}
        alt="Zeros"
        draggable={false}
        className="size-16 select-none [-webkit-user-drag:none]"
      />
      <div className="flex flex-wrap items-stretch justify-center gap-3">
        <StartTile
          icon={FolderOpen}
          label="Open project"
          description="Open a local folder"
          onClick={openProject}
        />
        <StartTile
          icon={GithubIcon}
          label="Open GitHub project"
          description="Clone a repository"
          onClick={openGithubProject}
        />
        <StartTile
          icon={Sparkles}
          label="Quick start"
          description="Start a fresh repo"
          onClick={quickStart}
        />
      </div>
    </div>
  );
}
