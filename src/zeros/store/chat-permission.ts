import type { ChatPermissionMode } from "./store";

/** Map persisted legacy and current permission values onto the current posture.
 * Kept outside the store barrel so cold-start cache hydration does not create a
 * runtime cycle through workspace-store. */
export function normalizeChatPermissionMode(
  value: unknown,
): ChatPermissionMode {
  switch (value) {
    case "plan":
    case "auto":
    case "tool-approval":
    case "danger":
      return value;
    case "plan-only":
      return "plan";
    case "ask":
      return "tool-approval";
    case "auto-edit":
    case "full":
      // Old "full" meant the most-permissive safe mode, not bypass.
      return "auto";
    default:
      return "auto";
  }
}
