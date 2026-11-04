import type { ExtensionEntry } from "@zeros/protocol/agent-extensions";

export const EXTENSION_STATUS_LABEL: Record<ExtensionEntry["status"], string> = {
  available: "Available",
  "needs-auth": "Sign-in required",
  unavailable: "Unavailable in Zeros",
  configured: "Configured",
  disabled: "Disabled in native config",
  found: "Found on disk",
};

/** The statuses the person has to act on, in Claude, Codex or Zeros. */
const NEEDS_PERSON = new Set<ExtensionEntry["status"]>(["needs-auth", "unavailable", "disabled"]);

export interface ExtensionEntryView {
  badge: { label: string; tone: "warning" | "neutral" } | null;
  /** The row's one line. */
  hint: string | undefined;
  /** More about an informational status, for the badge's tooltip. */
  detail: string | undefined;
}

/** What a skill, plugin or connector row says. Every status but Available
 * shows a badge; a status the person must act on gives its remedy the row's
 * one line, since the badge alone says what is wrong but not what to do. */
export function extensionEntryView(
  entry: Pick<ExtensionEntry, "status" | "statusDetail" | "description">,
): ExtensionEntryView {
  const needsPerson = NEEDS_PERSON.has(entry.status);
  return {
    badge:
      entry.status === "available"
        ? null
        : {
            label: EXTENSION_STATUS_LABEL[entry.status],
            tone: entry.status === "needs-auth" ? "warning" : "neutral",
          },
    hint: (needsPerson && entry.statusDetail) || entry.description || undefined,
    detail: needsPerson ? undefined : entry.statusDetail,
  };
}
