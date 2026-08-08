// Help → Feedback modal (also ⌥⌘F). Collects a typed message and posts it to
// the Intercom bridge Worker via submitFeedback(). There is deliberately no
// address field: the Worker reads the sender from the Auth0 access token the
// request carries, so the address support replies to is one Auth0 verified
// rather than whatever was typed here. With
// the "Include recent app logs" checkbox ticked, the secret-scrubbed recent
// log tail (app.jsonl — main + engine + renderer, see apps/desktop/electron/log-store.ts)
// rides along; View opens exactly that content as a .jsonl in TextEdit so the
// user can inspect what would be shared. On-brand chrome via the Zeros design
// primitives; all transient feedback goes through the toast surface.

import { useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/shared/ui/primitives/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/renderer/shared/ui/primitives/select";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { Textarea } from "@/renderer/shared/ui/primitives/textarea";
import { Label } from "@/renderer/shared/ui/primitives/label";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { isElectron, nativeInvoke } from "@/renderer/platform/runtime";
import {
  recentLogsForFeedback,
  submitFeedback,
  type FeedbackType,
} from "@/renderer/features/feedback/submit-feedback";

const TYPE_OPTIONS: { value: FeedbackType; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature request" },
  { value: "issue", label: "Issue" },
  { value: "feedback", label: "Feedback" },
];

export function FeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [type, setType] = useState<FeedbackType>("bug");
  const [message, setMessage] = useState("");
  const [includeLogs, setIncludeLogs] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setType("bug");
    setMessage("");
    setIncludeLogs(false);
  };

  const onViewLogs = async () => {
    try {
      await nativeInvoke("logs_export_open");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't open the log file.",
      );
    }
  };

  const onSubmit = async () => {
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    try {
      const logs = includeLogs ? await recentLogsForFeedback() : undefined;
      await submitFeedback({ type, message, logs });
      toast.success("Thanks — your feedback is on its way.");
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send feedback.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Report a bug, request a feature, or tell us how it&apos;s going.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="feedback-type">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as FeedbackType)}>
              <SelectTrigger id="feedback-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="feedback-message">Message</Label>
            <Textarea
              id="feedback-message"
              autoFocus
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tell us about the bug you found, an idea, or how it's going…"
            />
          </div>

          {isElectron() ? (
            <div className="flex items-center gap-2">
              <input
                id="feedback-include-logs"
                type="checkbox"
                checked={includeLogs}
                onChange={(e) => setIncludeLogs(e.target.checked)}
                className="size-3.5 shrink-0 accent-fg1"
              />
              <Label
                htmlFor="feedback-include-logs"
                className="text-fg2 grow cursor-pointer text-xs font-normal"
              >
                Include recent app logs (may include personal data)
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-fg2 h-6 px-2 text-xs"
                onClick={onViewLogs}
              >
                View
              </Button>
            </div>
          ) : null}

          <p className="text-xs text-muted-fg">
            {includeLogs
              ? "Your message plus the recent app logs shown under View are sent — secrets are scrubbed first."
              : "Only what you write here is sent — never your code, files, or keys."}
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={onSubmit} disabled={submitting || !message.trim()}>
            {submitting ? "Sending…" : "Send feedback"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
