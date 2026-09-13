// ──────────────────────────────────────────────────────────
// useWorkbenchFolder — the per-folder key for workbench panel state
// ──────────────────────────────────────────────────────────
//
// Everything per-folder in workbench hangs off ONE key: the terminal store's
// `activeTerminalTabByFolder` (terminal panel's selected tab), the terminal `folder`
// scope, panel layout, and `runSessionId`. Resolve it in one place so the
// terminal panel, seam, and Run button agree on the key (a mismatch would write
// state under a different key than the reader looks at).
//
// Resolution follows the workbench scope: the active workspace folder,
// including its persisted boot fallback, else the engine root, else "~".
// `chatCwd` is returned alongside so workspace-only controls stay gated when
// the workbench has no workspace owner.

import { useEffect, useState } from "react";

import {
  selectActiveFolder,
  useWorkspaceStore,
} from "../../state/workspace-store";
import { isElectron, nativeInvoke } from "../../platform/runtime";

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

export function useWorkbenchFolder(): {
  folderKey: string;
  chatCwd: string | undefined;
} {
  const chatCwd = useWorkspaceStore(selectActiveFolder) ?? undefined;
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
