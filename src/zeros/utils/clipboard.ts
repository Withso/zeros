/** Copy text to clipboard with fallback for restricted environments. Fire-and-
 *  forget; use copyToClipboardWithFallback when you need to report the outcome. */
export function copyToClipboard(text: string): void {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  } catch {
    fallbackCopy(text);
  }
}

/** Awaitable copy that reports whether the text actually landed on the
 *  clipboard, with the same navigator → execCommand fallback. For callers that
 *  must toast success/failure. The fallback matters when the async Clipboard API
 *  rejects with "Document is not focused" — which happens when focus is lost
 *  during an `await` BEFORE the write (e.g. after an IPC round-trip), since the
 *  API requires focus at write time, not at the originating gesture. The hidden-
 *  textarea + execCommand path is not subject to that constraint. */
export async function copyToClipboardWithFallback(
  text: string,
): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand path (unfocused document, API missing…).
  }
  return fallbackCopy(text);
}

/** @returns whether the copy succeeded (execCommand's own result). The void
 *  copyToClipboard caller ignores it — behavior there is unchanged. */
function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
