import type { QuestionSpec } from "../../platform/bridge/agent-events";

/** Question option previews are normally plain text. MCP URL elicitations use
 * one for a user-opened browser flow; only explicit web URLs become links. */
export function questionExternalUrl(
  question: QuestionSpec,
): { href: string; host: string } | null {
  for (const option of question.options) {
    if (typeof option.preview !== "string") continue;
    try {
      const url = new URL(option.preview);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return { href: url.href, host: url.host };
    } catch {
      // Continue scanning; another option may carry a valid URL.
    }
  }
  return null;
}
