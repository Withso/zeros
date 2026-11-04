import { FolderOpen, Plus } from "lucide-react";

import { GithubIcon } from "../../shared/ui";
import { Tile } from "../../shared/ui/primitives";

// --- TYPES ---

interface StartBanner {
  icon: typeof FolderOpen | typeof GithubIcon;
  label: string;
  description: string;
  onClick: () => void;
}

// --- CHILD COMPONENTS ---

function StartBannerButton({ icon: Icon, label, description, onClick }: StartBanner) {
  return (
    <Tile
      onClick={onClick}
      className="group flex min-w-0 items-center gap-3 p-3"
    >
      <Icon
        className="text-fg2 group-hover:text-fg1 size-5 shrink-0 transition-colors duration-120 ease-out"
        strokeWidth={1.5}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-fg1 truncate text-xs leading-4.5 font-medium">{label}</span>
        <span className="text-fg3 text-3xxs truncate leading-4">{description}</span>
      </span>
    </Tile>
  );
}

// --- COMPONENT ---

/** The three ways in, under the Create composer while no repository is added
 * or chosen: one row as wide as the composer, one column when it is narrow.
 * They run the same add-project flows as the Choose project menu. */
export function CreateStartBanners({
  onOpenProject,
  onOpenGithubProject,
  onQuickStart,
}: {
  onOpenProject: () => void;
  onOpenGithubProject: () => void;
  onQuickStart: () => void;
}) {
  const banners: StartBanner[] = [
    { icon: FolderOpen, label: "Open project", description: "Open a local folder", onClick: onOpenProject },
    { icon: GithubIcon, label: "Open GitHub project", description: "Clone a repository", onClick: onOpenGithubProject },
    { icon: Plus, label: "Start from scratch", description: "Start a fresh repo", onClick: onQuickStart },
  ];
  return (
    <div
      className="@container/starts mt-4"
      role="group"
      aria-label="Add a repository"
      data-create-start-banners=""
    >
      <div className="grid grid-cols-1 gap-2 @lg/starts:grid-cols-3 @lg/starts:gap-3">
        {banners.map((banner) => (
          <StartBannerButton key={banner.label} {...banner} />
        ))}
      </div>
    </div>
  );
}
