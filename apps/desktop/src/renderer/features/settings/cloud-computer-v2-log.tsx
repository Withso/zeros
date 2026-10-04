import { useEffect, useMemo } from "react";
import { useCachedRead } from "../../state/use-cached-read";
import { Button } from "../../shared/ui";
import { useInternalFeatureActive } from "./internal-features";
import {
  cloudComputerV2BuildCache,
  cloudComputerV2LogsCache,
  loadCloudComputerV2Build,
  loadCloudComputerV2Logs,
  readAndMergeCloudComputerV2Logs,
  readCloudComputerV2Build,
} from "./cloud-computer-v2-client";
import {
  startCloudComputerV2Polling,
  useCloudComputerV2Visible,
} from "./cloud-computer-v2-polling";
import type { CloudComputerV2BuildStage } from "@zeros/protocol/cloud-computer-v2";

export const cloudComputerV2Stages: Record<CloudComputerV2BuildStage, string> =
  {
    queued: "Queued",
    allocating: "Preparing computer",
    runtime: "Installing Zeros runtime",
    repositories: "Cloning repositories",
    install: "Installing software",
    integrity: "Checking protected files",
    sanitation: "Removing build credentials",
    stopping: "Stopping template",
    capture_confirmed: "Confirming template",
    done: "Complete",
  };

export function CloudComputerV2Log({
  buildKey,
  version,
  active,
}: {
  buildKey: string;
  version: number;
  active: boolean;
}) {
  const authorized = useInternalFeatureActive("cloudComputerV2");
  const enabled = useCloudComputerV2Visible(authorized && active);
  const build = useCachedRead(
    cloudComputerV2BuildCache,
    authorized ? buildKey : null,
    readCloudComputerV2Build,
    { enabled, maxAgeMs: 1000 },
  );
  const log = useCachedRead(
    cloudComputerV2LogsCache,
    authorized ? buildKey : null,
    readAndMergeCloudComputerV2Logs,
    { enabled, maxAgeMs: 1000 },
  );
  useEffect(() => {
    if (!enabled) return;
    return startCloudComputerV2Polling({
      immediate: false,
      read: async () => {
        const cached = cloudComputerV2LogsCache.peekSnapshot(buildKey).data;
        if (cached?.complete && cached.nextAfter >= (cached.lastSeq ?? 0))
          return { idle: true, complete: true };
        const before = cached?.nextAfter ?? 0;
        const summary = cloudComputerV2BuildCache.peekSnapshot(buildKey).data;
        const [result] = await Promise.all([
          loadCloudComputerV2Logs(buildKey, { force: true }),
          !summary || summary.state === "running" || summary.state === "queued"
            ? loadCloudComputerV2Build(buildKey, { force: true })
            : Promise.resolve(summary),
        ]);
        const complete =
          result.complete && result.nextAfter >= (result.lastSeq ?? 0);
        return { idle: before === result.nextAfter, complete };
      },
    });
  }, [enabled, buildKey]);
  const text = useMemo(
    () => log.data?.entries.map((entry) => entry.text).join("") ?? "",
    [log.data?.entries],
  );
  if (!authorized) return null;
  return (
    <div
      className="flex flex-col gap-2"
      {...(!active ? { inert: "" } : {})}
      aria-hidden={!active || undefined}
    >
      <p className="text-fg2 text-xs" role="status">
        Version {version} ·{" "}
        {build.data ? cloudComputerV2Stages[build.data.stage] : "Build log"}
      </p>
      {(log.error || build.error) && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-error text-xs">
            The build log could not be refreshed. Confirmed output is preserved.
          </p>
          <Button
            variant="ghost"
            disabled={!enabled}
            onClick={() => {
              log.refresh();
              build.refresh();
            }}
          >
            Retry log
          </Button>
        </div>
      )}
      {log.data?.truncated && (
        <p className="text-fg2 text-xs">Earlier output was truncated.</p>
      )}
      <pre
        role="log"
        aria-label={`Build log for version ${version}`}
        aria-live="off"
        tabIndex={enabled ? 0 : -1}
        className="bg-bg2 text-fg2 max-h-80 overflow-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap"
      >
        {text ||
          (log.loading
            ? "Loading build log…"
            : log.data?.complete
              ? "No build output."
              : "Waiting for build output…")}
      </pre>
    </div>
  );
}
