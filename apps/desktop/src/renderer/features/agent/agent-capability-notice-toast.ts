import type { AgentCapabilityNoticeMessage } from "../../platform/bridge/messages";
import { toast } from "../../shared/ui/primitives/elements/toast";

// Every new chat re-detects the same install, so each notice and plugin
// version is shown once for this renderer's lifetime.
const notified = new Set<string>();

const CODEX_BROWSER_TITLE = "Codex can't use its built-in browser";
const CODEX_FALLBACK_TITLE =
  "Codex's built-in browser isn't available, so Codex is using the Zeros browser.";

/** Show an engine capability notice as a toast: informational when Zeros
 * substituted the capability, a warning when the chat goes without it.
 * Returns whether a toast was emitted. */
export function notifyAgentCapabilityNotice(
  message: Pick<AgentCapabilityNoticeMessage, "notice">,
): boolean {
  const { code, version, fallback } = message.notice;
  // A newer engine may name a substitute this renderer has no wording for.
  if (fallback !== undefined && fallback !== "zeros-browser") return false;
  const usingZerosBrowser = fallback === "zeros-browser";
  let fix: string | undefined;
  switch (code) {
    case "codex-browser-plugin-incomplete":
      fix =
        "Open the ChatGPT app once so it can finish setting up its Browser plugin.";
      break;
    case "codex-browser-plugin-unsupported":
      fix = `Zeros doesn't support ${
        version ? `version ${version} of ` : ""
      }ChatGPT's Browser plugin yet.`;
      break;
    case "codex-browser-config-conflict":
      fix =
        "A Codex configuration file changes node_repl in a way Zeros can't verify, such as a project's .codex/config.toml.";
      break;
    case "codex-browser-unavailable":
      if (!usingZerosBrowser) return false;
      break;
    default:
      // A newer engine may send codes this renderer has no wording for.
      return false;
  }
  const key = `${code}:${version ?? ""}:${fallback ?? ""}`;
  if (notified.has(key)) return false;
  notified.add(key);
  const id = `agent-capability-notice:${key}`;
  if (usingZerosBrowser) {
    toast.info(CODEX_FALLBACK_TITLE, fix ? { id, description: fix } : { id });
  } else {
    toast.warning(CODEX_BROWSER_TITLE, {
      id,
      description: `${fix} Codex will work without a browser in this chat.`,
    });
  }
  return true;
}
