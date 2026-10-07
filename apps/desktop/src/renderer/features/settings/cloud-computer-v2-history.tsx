import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudComputerV2BuildSummary,
  CloudComputerV2State,
} from "@zeros/protocol/cloud-computer-v2";
import { Button } from "../../shared/ui";
import { getOrganizationStoreGeneration } from "../team/team-store";
import { loadCloudComputerV2History } from "./cloud-computer-v2-client";
import { SettingsList, SettingsRow, SettingsSection } from "./settings-ui";

type OlderPage = { cursor: string; rows: CloudComputerV2BuildSummary[] };
function boundOlderPages(pages: OlderPage[], remaining: number): OlderPage[] {
  const bounded: OlderPage[] = [];
  for (let index = pages.length - 1; index >= 0 && remaining > 0; index--) {
    const page = pages[index];
    const rows = page.rows.slice(-remaining);
    if (rows.length) bounded.unshift({ ...page, rows });
    remaining -= rows.length;
  }
  return bounded;
}

export function CloudComputerV2History({
  scopeKey,
  snapshot,
  active,
  refreshVersion = 0,
  disabled,
  onWarmLog,
  onOpenLog,
  onAction,
}: {
  scopeKey: string;
  snapshot: CloudComputerV2State;
  active: boolean;
  refreshVersion?: number;
  disabled: boolean;
  onWarmLog: (row: CloudComputerV2BuildSummary) => void;
  onOpenLog: (row: CloudComputerV2BuildSummary) => void;
  onAction: (
    kind: "activate" | "rebuild",
    row: CloudComputerV2BuildSummary,
  ) => Promise<CloudComputerV2BuildSummary | void>;
}) {
  const [older, setOlder] = useState({
    revision: snapshot.revision,
    pages: [] as OlderPage[],
    cursor: snapshot.history.nextCursor,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const mounted = useRef(true),
    pending = useRef(false);
  const refreshed = useRef(refreshVersion);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (older.revision !== snapshot.revision)
    setOlder({
      revision: snapshot.revision,
      pages: [],
      cursor: snapshot.history.nextCursor,
    });
  const rows = useMemo(() => {
    const recent = new Set(snapshot.history.builds.map((row) => row.id));
    return [
      ...snapshot.history.builds,
      ...older.pages
        .flatMap((page) => page.rows)
        .filter((row) => !recent.has(row.id)),
    ].sort((a, b) => b.version - a.version);
  }, [snapshot.history.builds, older.pages]);
  useEffect(() => {
    if (!active || busy || refreshed.current === refreshVersion)
      return;
    refreshed.current = refreshVersion;
    if (!older.pages.length || older.revision !== snapshot.revision) return;
    const epoch = getOrganizationStoreGeneration(),
      revision = snapshot.revision;
    pending.current = true;
    setBusy(true);
    setError(false);
    // Templates can retire without a head write. Explicit Refresh revalidates
    // the bounded displayed pages while keeping their confirmed rows visible.
    void Promise.all(
      older.pages.map((page) =>
        loadCloudComputerV2History(scopeKey, page.cursor, { force: true }),
      ),
    )
      .then((pages) => {
        if (!mounted.current || epoch !== getOrganizationStoreGeneration())
          return;
        if (pages.some((page) => page.revision !== revision)) {
          setError(true);
          return;
        }
        setOlder((current) =>
          current.revision !== revision
            ? current
            : {
                revision,
                pages: boundOlderPages(
                  pages.map((page, index) => ({
                    cursor: older.pages[index].cursor,
                    rows: page.history.builds,
                  })),
                  100 - snapshot.history.builds.length,
                ),
                cursor: pages.at(-1)!.history.nextCursor,
              },
        );
      })
      .catch(() => {
        if (mounted.current && epoch === getOrganizationStoreGeneration())
          setError(true);
      })
      .finally(() => {
        pending.current = false;
        if (mounted.current) setBusy(false);
      });
  }, [
    active,
    busy,
    refreshVersion,
    scopeKey,
    older,
    snapshot.revision,
    snapshot.history.builds.length,
  ]);
  const readOlder = async () => {
    if (!active || !older.cursor || pending.current) return;
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
              pages: boundOlderPages(
                [
                  ...current.pages,
                  { cursor: older.cursor!, rows: page.history.builds },
                ],
                100 - snapshot.history.builds.length,
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
  const act = async (
    kind: "activate" | "rebuild",
    row: CloudComputerV2BuildSummary,
  ) => {
    if (!active || disabled || pending.current) return;
    const epoch = getOrganizationStoreGeneration();
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const confirmed = await onAction(kind, row);
      if (
        !confirmed ||
        !mounted.current ||
        epoch !== getOrganizationStoreGeneration()
      )
        return;
      setOlder((current) => ({
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          rows: page.rows.map((entry) =>
            entry.id === confirmed.id ? confirmed : entry,
          ),
        })),
      }));
    } catch {
      if (mounted.current && epoch === getOrganizationStoreGeneration())
        setError(true);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (!rows.length) return null;
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
                  disabled={disabled || !active || busy}
                  onClick={() => void act("activate", row)}
                >
                  Activate
                </Button>
              )}
            {row.state === "succeeded" && row.templateState === "retired" && (
              <Button
                variant="secondary"
                disabled={disabled || !active || busy}
                onClick={() => void act("rebuild", row)}
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
        <p className="text-red-primary text-xs" role="alert">
          History could not be refreshed. Refresh Cloud Computer and try again.
        </p>
      )}
    </SettingsSection>
  );
}
