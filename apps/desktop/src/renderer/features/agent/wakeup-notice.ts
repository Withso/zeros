import type { WakeupNoticeInfo } from "@zeros/protocol/agent-events";
import { wakeupNoticeText } from "@zeros/protocol/agent-messages";

/** Native due times are absolute; display them in the reader's timezone. */
export function wakeupDisplayText(info: WakeupNoticeInfo, locales?: string, timeZone?: string): string {
  const due = info.scheduledFor;
  if (!info.reason?.trim()) return wakeupNoticeText({ source: info.source });
  if (typeof due !== "number" || !Number.isFinite(due) || due <= 0 || due > 8.64e15)
    return wakeupNoticeText({ source: info.source, reason: info.reason.trim() });
  const format = new Intl.DateTimeFormat(locales, { hour: "numeric", minute: "2-digit", timeZone });
  return wakeupNoticeText(info, timestamp => format.format(timestamp));
}
