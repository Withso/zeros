// ──────────────────────────────────────────────────────────
// OpenSettingsFileButton — reveal a settings TOML file in Finder
// ──────────────────────────────────────────────────────────
//
// One button shape shared by the repo page (its personal
// `.zeros/settings.local.toml`) and the Settings page (the user
// `~/.zeros/settings.toml`). Hand-edits happen in your OWN editor, not an
// in-app code box: the button reveals the file in Finder, seeding it on first
// use so Finder has something to select. The exists/path read happens fresh AT
// CLICK TIME (not from hook state) — a cached read could reveal the previous
// repo's file right after a repo switch, or seed over a file another device
// created since the cache was taken. Hidden outside the native runtime — a
// web/relay client has no Finder to reveal into.

import { useState } from "react";

import { Button } from "./primitives/button";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { toast } from "./primitives/elements";
import { revealInFinder } from "../../platform/app";
import { isNativeRuntime } from "../../platform/runtime";
import { useBridge } from "../../platform/bridge/use-bridge";
import {
  bridgeSettingsRead,
  bridgeSettingsWriteRaw,
} from "../../platform/bridge/workspace-bridge";

export function OpenSettingsFileButton({
  layer,
  repoRoot,
  label,
  tooltip,
  seed,
}: {
  /** Which settings file to reveal — the writable personal layers only. */
  layer: "user" | "repo-local";
  /** Repo root — required for "repo-local", omitted for "user". */
  repoRoot?: string;
  /** Button text, naming the file it opens (e.g. "Open settings.toml"). */
  label: string;
  /** Tooltip — the file's role + a "reveal in Finder" hint. */
  tooltip: string;
  /** Comment-only TOML written on first use so Finder has a file to select. */
  seed: string;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  if (!isNativeRuntime()) return null;

  const handleOpen = async () => {
    if (!bridge || busy) return;
    setBusy(true);
    try {
      const read = await bridgeSettingsRead(bridge, layer, repoRoot);
      if (!read.exists) {
        await bridgeSettingsWriteRaw(bridge, layer, seed, repoRoot);
      }
      await revealInFinder(read.path);
    } catch {
      toast.error(`Couldn't open ${label.replace(/^Open\s+/i, "")}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tooltip label={tooltip}>
      <Button
        variant="secondary"
        size="sm"
        disabled={!bridge || busy}
        onClick={() => void handleOpen()}
      >
        {label}
      </Button>
    </Tooltip>
  );
}
