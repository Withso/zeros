import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudComputerV2BuildSummary,
  CloudComputerV2State,
} from "@zeros/protocol/cloud-computer-v2";
import { Button } from "../../shared/ui";
import { getOrganizationStoreGeneration } from "../team/team-store";
import { useInternalFeatureActive } from "./internal-features";
import { loadCloudComputerV2History } from "./cloud-computer-v2-client";
import { SettingsList, SettingsRow, SettingsSection } from "./settings-ui";

export function CloudComputerV2History({
  scopeKey,
  snapshot,
  active,
  disabled,
  onWarmLog,
  onOpenLog,
  onAction,
}: {
  scopeKey: string;
  snapshot: CloudComputerV2State;
  active: boolean;
  disabled: boolean;
  onWarmLog: (row: CloudComputerV2BuildSummary) => void;
  onOpenLog: (row: CloudComputerV2BuildSummary) => void;
  onAction: (
    kind: "activate" | "rebuild",
    row: CloudComputerV2BuildSummary,
  ) => void;
}) {
  const authorized = useInternalFeatureActive("cloudComputerV2");
  const [older, setOlder] = useState({
    revision: snapshot.revision,
    rows: [] as CloudComputerV2BuildSummary[],
    cursor: snapshot.history.nextCursor,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (older.revision !== snapshot.revision)
    setOlder({
      revision: snapshot.revision,
      rows: [],
      cursor: snapshot.history.nextCursor,
    });
  const rows = useMemo(() => {
    const recent = new Set(snapshot.history.builds.map((row) => row.id));
    return [
      ...snapshot.history.builds,
      ...older.rows.filter((row) => !recent.has(row.id)),
    ].sort((a, b) => b.version - a.version);
  }, [snapshot.history.builds, older.rows]);
  const readOlder = async () => {
    if (!authorized || !active || !older.cursor || pending.current) return;
    const epoch = getOrganizationStoreGeneration(),
      revision = snapshot.revision;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const page = await loadCloudComputerV2History(scopeKey, older.cursor);
      if (!mounted.current || epoch !== getOrganizationStoreGeneration())
        return;
      if (page.revision !== revision) {
        setError(true);
        return;
      }
      setOlder((current) =>
        current.revision !== revision
          ? current
          : {
              revision,
              // Keep a bounded window of older rows alongside the recent server page.
              rows:
                snapshot.history.builds.length >= 100
                  ? []
                  : [...current.rows, ...page.history.builds].slice(
                      -(100 - snapshot.history.builds.length),
                    ),
              cursor: page.history.nextCursor,
            },
      );
    } catch {
      if (mounted.current && epoch === getOrganizationStoreGeneration())
        setError(true);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (!authorized || !rows.length) return null;
  return (
    <SettingsSection title="History">
      <SettingsList>
        {rows.map((row) => (
          <SettingsRow
            key={row.id}
            label={`Version ${row.version} · ${row.state}`}
            hint={`${new Date(row.createdAt).toLocaleString()}${row.templateState === "retired" ? " · Template retired" : ""}`}
          >
            <Button
              variant="ghost"
              disabled={!active}
              aria-label={`View log for version ${row.version}`}
              onPointerEnter={() => active && onWarmLog(row)}
              onFocus={() => active && onWarmLog(row)}
              onClick={() => onOpenLog(row)}
            >
              View log
            </Button>
            {row.state === "succeeded" &&
              row.templateState === "ready" &&
              snapshot.active?.id !== row.id && (
                <Button
                  variant="secondary"
                  disabled={disabled || !active}
                  onClick={() => onAction("activate", row)}
                >
                  Activate
                </Button>
              )}
            {row.state === "succeeded" && row.templateState === "retired" && (
              <Button
                variant="secondary"
                disabled={disabled || !active}
                onClick={() => onAction("rebuild", row)}
              >
                Rebuild
              </Button>
            )}
          </SettingsRow>
        ))}
      </SettingsList>
      {older.cursor && (
        <Button
          variant="ghost"
          disabled={!active || busy}
          onClick={() => void readOlder()}
        >
          Older versions
        </Button>
      )}
      {error && (
        <p className="text-error text-xs" role="alert">
          History could not be refreshed. Refresh Cloud Computer and try again.
        </p>
      )}
    </SettingsSection>
  );
}
