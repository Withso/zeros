import { useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  IconButton,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import { renderMarkdown } from "@/renderer/features/agent/markdown";
import { shellOpenUrl } from "@/renderer/platform/app";
import {
  reviewCommentLocation,
  type ReviewCommentReference,
} from "./review-comment-reference";

const DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** The whole comment as GitHub shows it: who, when, and its Markdown. */
export function ReviewCommentPreviewDialog({
  reference,
  open,
  onOpenChange,
}: {
  reference: ReviewCommentReference;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const html = useMemo(
    () => (open ? renderMarkdown(reference.body) : ""),
    [open, reference.body],
  );
  const where = reviewCommentLocation(reference, true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-review-comment-preview="">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <Avatar size="sm" className="size-5 shrink-0">
              {reference.author.avatarUrl ? (
                <AvatarImage src={reference.author.avatarUrl} alt="" />
              ) : null}
              <AvatarFallback className="text-2xxs uppercase">
                {reference.author.name.slice(0, 1) || "?"}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 truncate">{reference.author.name}</span>
            {reference.author.bot ? <Badge variant="neutral">Bot</Badge> : null}
            {reference.createdAt > 0 ? (
              <span className="text-fg3 shrink-0 text-xs font-normal">
                {DATE.format(reference.createdAt)}
              </span>
            ) : null}
            <span className="flex-1" />
            {reference.url ? (
              <Tooltip label="Open on GitHub">
                <IconButton
                  size="compact"
                  label="Open comment on GitHub"
                  onClick={() => void shellOpenUrl(reference.url!).catch(() => {})}
                >
                  <ArrowUpRight />
                </IconButton>
              </Tooltip>
            ) : null}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="max-h-[70vh] overflow-y-auto">
          {where ? (
            <p className="text-fg3 m-0 mb-2 font-mono text-xs">{where}</p>
          ) : null}
          <div className="zeros-agent-md zeros-agent-md--panel min-w-0 break-words [&_.zeros-md-prose>:first-child]:mt-0 [&_.zeros-md-prose>:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto">
            <div
              className="zeros-md-prose text-sm"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
