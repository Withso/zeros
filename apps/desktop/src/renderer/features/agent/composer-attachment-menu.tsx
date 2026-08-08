import { memo, useEffect, useState } from "react";
import { FolderInput, MessageSquareText, Paperclip, Plus } from "lucide-react";

import { Button } from "../../shared/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { Tooltip } from "@/renderer/shared/ui/primitives";

interface ComposerAttachmentMenuProps {
  concealed: boolean;
  onAttachFiles: () => void;
  onAttachTranscript: () => void;
  onLinkWorkspace: () => void;
  /** Pointer/focus intent warms the transcript catalog without changing the
   *  parent AgentChat's render state. */
  onIntent: () => void;
}

/**
 * The composer's small, latency-sensitive "+" island. Its open state lives
 * here so clicking the trigger renders only Radix's three-row overlay instead
 * of re-running the full transcript-owning AgentChat component.
 */
export const ComposerAttachmentMenu = memo(function ComposerAttachmentMenu({
  concealed,
  onAttachFiles,
  onAttachTranscript,
  onLinkWorkspace,
  onIntent,
}: ComposerAttachmentMenuProps) {
  const [open, setOpen] = useState(false);

  // Derived closure happens in the same parent render that conceals the card;
  // syncing local state prevents the menu from springing open when it returns.
  useEffect(() => {
    if (concealed && open) setOpen(false);
  }, [concealed, open]);

  return (
    <DropdownMenu open={open && !concealed} onOpenChange={setOpen}>
      <Tooltip label="Attach or link">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="Add attachment or link a workspace"
            className="rounded-sm"
            onPointerEnter={onIntent}
            onFocus={onIntent}
          >
            <Plus size={14} />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        data-composer-attachment-menu=""
        align="start"
        side="top"
      >
        <DropdownMenuItem onSelect={() => window.setTimeout(onAttachFiles, 0)}>
          <Paperclip size={14} />
          Add attachment
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => window.setTimeout(onAttachTranscript, 0)}
        >
          <MessageSquareText size={14} />
          Attach chat transcript
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => window.setTimeout(onLinkWorkspace, 0)}
        >
          <FolderInput size={14} />
          Link workspaces
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
