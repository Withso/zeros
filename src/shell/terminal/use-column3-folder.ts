// ──────────────────────────────────────────────────────────
// useColumn3Folder — the per-folder key for column-3 panel state
// ──────────────────────────────────────────────────────────
//
// Everything per-folder in column 3 hangs off ONE key: the terminal store's
// `activeTerminalTabByFolder` (row 2's selected tab), the terminal `folder`
// scope, panel layout, and `runSessionId`. Resolve it in one place so the
// terminal panel, seam, and Run button agree on the key (a mismatch would write
// state under a different key than the reader looks at).
//
// Resolution: the active chat's cwd, else
// the engine root (a chatless surface still gets a sensible cwd), else "~".
// `chatCwd` is returned alongside so callers can honor the chatCwd-only gating
// (e.g. no Run terminal on a chatless surface).

import { useEffect, useState } from "react";

import { useChatCwd } from "../use-chat-cwd";
import { isElectron, nativeInvoke } from "../../native/runtime";

const FALLBACK_FOLDER = "~";

async function resolveEngineRoot(): Promise<string> {
  if (!isElectron()) return "";
  try {
    const root = await nativeInvoke<string | null>("get_engine_root");
    return root ?? "";
  } catch {
    return "";
  }
}

export function useColumn3Folder(): {
  folderKey: string;
  chatCwd: string | undefined;
} {
  const chatCwd = useChatCwd();
  const [engineRoot, setEngineRoot] = useState<string>("");
  // Refresh on every chat-cwd flip in case the user just opened their first
  // project.
  useEffect(() => {
    let cancelled = false;
    void resolveEngineRoot()
      .then((root) => {
        if (!cancelled) setEngineRoot(root);
      })
      .catch(() => {
        /* leave engineRoot empty — folder fallback is FALLBACK_FOLDER */
      });
    return () => {
      cancelled = true;
    };
  }, [chatCwd]);

  const folder = chatCwd ?? engineRoot ?? "";
  return { folderKey: folder || FALLBACK_FOLDER, chatCwd };
}
