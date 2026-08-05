// ──────────────────────────────────────────────────────────
// Customize page — agent capabilities, scoped User / per-repo
// ──────────────────────────────────────────────────────────
//
// PAGE: CustomizePage
// ROUTE: activePage === "customize" (Home rail row below Dashboard)
// PURPOSE: One place to extend agents: MCP servers today, Skills / Plugins /
//          Subagents later (add a CATEGORIES entry). The page has a SCOPE —
//          "User" (the machine-wide layer every repo inherits) or one repo
//          (its personal, gitignored `.zeros/settings.local.toml`) — chosen
//          from the header dropdown, plus a category pill row. MCP left
//          Settings for this page (2026-07-22); user-level servers still
//          apply everywhere, and a repo scope shows ONLY that repo's own
//          servers (inheritance is implicit, stated in a footnote — not
//          repeated as rows).
//
//          "New MCP server" / editing opens an IN-PAGE form (breadcrumb back),
//          not a dialog — see mcp-server-form.tsx.
//
// Scope is a durable selection persisted under `customize:active-scope`
// ("user" | "repo:<projectId>"), validated against the live project list on
// every render (a removed repo falls back to User). The list⇄form view and
// the form draft are ephemeral by design — leaving the page mid-draft keeps
// it (the page stays mounted in the Home deck), but switching scope resets
// to the list so a draft can never land in the wrong scope.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, CircleUser } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { RepositoryIcon } from "../repositories/repository-icon";
import { getSetting, setSetting } from "../../platform/settings";
import { useAuth } from "../auth";
import { useProjects } from "../../state/use-projects";
import type { Project } from "../../state/projects-store";
import { useInstantViewSwitch } from "../../shared/ui/use-instant-view-switch";
import { useScrollMemoryRef } from "../../shell/scroll-memory";
import { prefetchSettingsForRepo } from "../settings/use-settings";
import {
  decodeCustomizeScope,
  encodeCustomizeScope,
  type CustomizeScope,
} from "./customize-model";
import { CustomizeMcpSection } from "./customize-mcp";
import { McpServerFormPage } from "./mcp-server-form";

// ── Category model ───────────────────────────────────────
//
// One entry per capability family. Adding Skills / Plugins later is one line
// here plus its section component — the header pills render from this array.

const CATEGORIES = [{ id: "mcp", label: "MCP" }] as const;
type CategoryId = (typeof CATEGORIES)[number]["id"];

const SCOPE_SETTING_KEY = "customize:active-scope";

/** The list⇄form navigation inside the page. Ephemeral (never persisted):
 *  a draft form must not survive a reload pointing at a stale index. */
type CustomizeView = { kind: "list" } | { kind: "form"; index: number | null };

/** The validated, render-ready scope: user, or a LIVE project. */
export type ResolvedCustomizeScope =
  | { kind: "user" }
  | { kind: "repo"; project: Project };

// Same trigger recipe as the models page's model dropdown — a Select-shaped
// button (the scope menu needs grouped rows a Radix Select can't hold).
const SCOPE_TRIGGER_CLS =
  "border-border3 hover:border-border4 hover:bg-bg2 data-[state=open]:border-border4 data-[state=open]:bg-bg2 flex h-8 min-w-[150px] max-w-[280px] items-center gap-2 rounded-sm border bg-transparent px-3 text-sm whitespace-nowrap shadow-xs outline-none";

function ScopePicker({
  scope,
  projects,
  onChange,
}: {
  scope: ResolvedCustomizeScope;
  projects: Project[];
  onChange: (scope: CustomizeScope) => void;
}) {
  const { session, email } = useAuth();
  const displayName = session?.user.name ?? email ?? "User";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Customize scope"
          className={SCOPE_TRIGGER_CLS}
        >
          {scope.kind === "user" ? (
            <CircleUser
              className="text-fg2 size-4 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <span
              className="bg-bg2-hover inline-flex size-4 shrink-0 items-center justify-center rounded-sm"
              aria-hidden="true"
            >
              <RepositoryIcon
                project={scope.project}
                className="size-full rounded-sm"
              />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {scope.kind === "user" ? displayName : scope.project.name}
          </span>
          <ChevronDown className="text-fg2 size-4 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuItem
          onSelect={() => onChange({ kind: "user" })}
          className="items-start gap-2.5"
        >
          <CircleUser className="mt-0.5" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-fg1 truncate text-sm">User</span>
            <span className="text-fg2 truncate text-xs">{displayName}</span>
          </span>
          {scope.kind === "user" && (
            <Check className="text-fg1 mt-0.5 size-3.5 shrink-0" />
          )}
        </DropdownMenuItem>
        {projects.length > 0 && (
          <DropdownMenuLabel className="text-fg2">Repos</DropdownMenuLabel>
        )}
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => onChange({ kind: "repo", projectId: p.id })}
            // Repo scopes read that repo's settings layer — warm it on hover
            // so the switch paints from a complete snapshot.
            onPointerEnter={() => prefetchSettingsForRepo(p.repoRoot)}
            className="items-start gap-2.5"
          >
            <span
              className="bg-bg2-hover mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm"
              aria-hidden="true"
            >
              <RepositoryIcon project={p} className="size-full rounded-sm" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-fg1 truncate text-sm">{p.name}</span>
              <span className="text-fg2 truncate text-xs">{p.repoSlug}</span>
            </span>
            {scope.kind === "repo" && scope.project.id === p.id && (
              <Check className="text-fg1 mt-0.5 size-3.5 shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CustomizePage({
  surfaceActive = true,
}: {
  /** False while the Home deck keeps this page mounted but hidden. */
  surfaceActive?: boolean;
}) {
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const { projects } = useProjects();

  // The persisted scope string is the source of truth; the RESOLVED scope is
  // re-validated against the live project list every render, so removing the
  // selected repo (or a stale persisted id) degrades to User with no dead view.
  const [scopeRaw, setScopeRaw] = useState<string>(() =>
    getSetting<string>(SCOPE_SETTING_KEY, "user"),
  );
  const projectIds = useMemo(
    () => new Set(projects.map((p) => p.id)),
    [projects],
  );
  const scope = useMemo<ResolvedCustomizeScope>(() => {
    const decoded = decodeCustomizeScope(scopeRaw, projectIds);
    if (decoded.kind === "user") return { kind: "user" };
    const project = projects.find((p) => p.id === decoded.projectId);
    return project ? { kind: "repo", project } : { kind: "user" };
  }, [scopeRaw, projectIds, projects]);
  const scopeKey = scope.kind === "user" ? "user" : `repo:${scope.project.id}`;

  const setScope = (next: CustomizeScope) => {
    const encoded = encodeCustomizeScope(next);
    setScopeRaw(encoded);
    setSetting(SCOPE_SETTING_KEY, encoded);
  };

  // When a persisted repo scope degrades to User (its repo was removed),
  // WRITE the fallback back — otherwise the stale "repo:<id>" lingers and
  // re-adding that repo in a later session would silently snap the page back
  // (discarding whatever the user was doing at User scope). The empty-at-boot
  // guard mirrors the settings page's repo redirect: an un-hydrated project
  // list must not eat a valid persisted scope.
  const prevProjectsLenRef = useRef(projects.length);
  useEffect(() => {
    const prevLen = prevProjectsLenRef.current;
    prevProjectsLenRef.current = projects.length;
    if (scopeRaw === "user") return;
    if (projects.length === 0 && prevLen === 0) return;
    if (decodeCustomizeScope(scopeRaw, projectIds).kind === "user") {
      setScopeRaw("user");
      setSetting(SCOPE_SETTING_KEY, "user");
    }
  }, [scopeRaw, projects.length, projectIds]);

  const [category, setCategory] = useState<CategoryId>("mcp");
  const [view, setView] = useState<CustomizeView>({ kind: "list" });

  // Scope changes (including a selected repo disappearing) leave the form:
  // a draft must never save into a different scope than it was opened in.
  const prevScopeKey = useRef(scopeKey);
  useEffect(() => {
    if (prevScopeKey.current !== scopeKey) {
      prevScopeKey.current = scopeKey;
      setView({ kind: "list" });
    }
  }, [scopeKey]);

  // Include the form's TARGET so each edited server gets its own instant-view
  // + scroll-memory identity (editing #5 must not restore #0's offset).
  const viewKey = `${scopeKey}:${category}:${
    view.kind === "form" ? `form:${view.index ?? "new"}` : "list"
  }`;
  useInstantViewSwitch(`customize:${viewKey}`, pageSurfaceRef);
  const pageScrollRef = useScrollMemoryRef(`customize:${viewKey}`);

  return (
    <div
      ref={pageSurfaceRef}
      className="bg-bg1 flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div ref={pageScrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full max-w-5xl flex-col pt-10 pr-6 pb-16 pl-[clamp(1.5rem,5vw,6.25rem)]">
          {view.kind === "form" ? (
            <McpServerFormPage
              key={`${scopeKey}:${view.index ?? "new"}`}
              scope={scope}
              index={view.index}
              onBack={() => setView({ kind: "list" })}
            />
          ) : (
            <>
              <div className="flex flex-col items-start gap-5">
                <div className="flex flex-col gap-1">
                  <h1 className="text-fg1 m-0 text-lg leading-tight font-medium">
                    Customize
                  </h1>
                  <p className="text-fg2 m-0 text-sm">
                    Extend your agents. User servers apply to every repo; a
                    repo&rsquo;s servers apply only there.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <ScopePicker
                    scope={scope}
                    projects={projects}
                    onChange={setScope}
                  />
                  <div
                    className="bg-border1 h-5 w-px shrink-0"
                    aria-hidden="true"
                  />
                  <Tabs
                    value={category}
                    onValueChange={(v) => setCategory(v as CategoryId)}
                  >
                    <TabsList className="h-8">
                      {CATEGORIES.map((c) => (
                        <TabsTrigger
                          key={c.id}
                          value={c.id}
                          className="text-xs"
                        >
                          {c.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>
              </div>

              <div className="w-full pt-8">
                {category === "mcp" && (
                  <CustomizeMcpSection
                    key={scopeKey}
                    scope={scope}
                    surfaceActive={surfaceActive}
                    onNew={() => setView({ kind: "form", index: null })}
                    onEdit={(index) => setView({ kind: "form", index })}
                    onSwitchToUser={() => setScope({ kind: "user" })}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
