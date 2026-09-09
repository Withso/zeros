// ──────────────────────────────────────────────────────────
// Customize page — agent capabilities, scoped User / per-repo
// ──────────────────────────────────────────────────────────
//
// PAGE: CustomizePage
// ROUTE: activePage === "customize" (Home rail row below Dashboard)
// PURPOSE: Personal MCP/Skills editing and read-only native inventories for
// MCP, Skills, Plugins, and Apps. Scope and provider selections are durable;
// form identity includes the scope so drafts cannot move between repositories.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  EXTENSION_CATEGORIES,
  extensionProviders,
  type ExtensionCategory,
  type ExtensionProvider,
} from "@zeros/protocol/agent-extensions";
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
  decodeCustomizeSelection,
  encodeCustomizeScope,
  type CustomizeScope,
} from "./customize-model";
import { CustomizeMcpSection } from "./customize-mcp";
import { McpServerFormPage } from "./mcp-server-form";
import { CustomizeExtensionsSection } from "./customize-extensions";
import { prefetchExtensions } from "./extensions-cache";

// ── Category model ───────────────────────────────────────
//
// The provider row is constrained by the selected category.

const CATEGORY_LABELS = {
  mcp: "MCP",
  skills: "Skills",
  plugins: "Plugins",
  apps: "Apps",
};
const PROVIDER_LABELS = {
  zeros: "Zeros",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};
const SELECTION_SETTING_KEY = "customize:selection";

const SCOPE_SETTING_KEY = "customize:active-scope";

/** The list⇄form navigation inside the page. Ephemeral (never persisted):
 *  a draft form must not survive a reload pointing at a stale index. */
type CustomizeView =
  | { kind: "list" }
  | { kind: "form"; index: number | null; owner: string };

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

  const [selection, setSelection] = useState(() =>
    decodeCustomizeSelection(getSetting(SELECTION_SETTING_KEY, null)),
  );
  const { category, provider } = selection;
  const select = (nextCategory: ExtensionCategory, nextProvider = provider) => {
    const next = decodeCustomizeSelection({
      category: nextCategory,
      provider: nextProvider,
    });
    setSelection(next);
    setSetting(SELECTION_SETTING_KEY, next);
    setView({ kind: "list" });
  };
  const [view, setView] = useState<CustomizeView>({ kind: "list" });
  const owner = `${scopeKey}:${scope.kind === "repo" ? scope.project.repoRoot : ""}:${category}:${provider}`;
  const activeView =
    view.kind === "form" && view.owner === owner
      ? view
      : { kind: "list" as const };
  const query = {
    category,
    provider,
    ...(scope.kind === "repo" ? { repoRoot: scope.project.repoRoot } : {}),
  };
  const warm = (
    nextCategory: ExtensionCategory,
    nextProvider: ExtensionProvider,
  ) => {
    if (!surfaceActive) return;
    prefetchExtensions({
      ...query,
      ...decodeCustomizeSelection({
        category: nextCategory,
        provider: nextProvider,
      }),
    });
  };

  // Include the form's TARGET so each edited server gets its own instant-view
  // + scroll-memory identity (editing #5 must not restore #0's offset).
  const viewKey = `${owner}:${
    activeView.kind === "form" ? `form:${activeView.index ?? "new"}` : "list"
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
          {activeView.kind === "form" ? (
            <McpServerFormPage
              key={`${owner}:${activeView.index ?? "new"}`}
              scope={scope}
              index={activeView.index}
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
                    Extend your agents with MCP servers, skills, plugins, and
                    apps.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <ScopePicker
                    scope={scope}
                    projects={projects}
                    onChange={(next) => {
                      setView({ kind: "list" });
                      setScope(next);
                    }}
                  />
                  <div
                    className="bg-border1 h-5 w-px shrink-0"
                    aria-hidden="true"
                  />
                  <Tabs
                    value={category}
                    onValueChange={(v) => select(v as ExtensionCategory)}
                  >
                    <TabsList className="h-8">
                      {EXTENSION_CATEGORIES.map((id) => (
                        <TabsTrigger
                          key={id}
                          value={id}
                          className="text-xs"
                          onPointerEnter={() => warm(id, provider)}
                          onFocus={() => warm(id, provider)}
                        >
                          {CATEGORY_LABELS[id]}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </div>
                <Tabs
                  value={provider}
                  onValueChange={(value) =>
                    select(category, value as ExtensionProvider)
                  }
                >
                  <TabsList className="h-8" aria-label="Agent provider">
                    {extensionProviders(category).map((id) => (
                      <TabsTrigger
                        key={id}
                        value={id}
                        className="text-xs"
                        onPointerEnter={() => warm(category, id)}
                        onFocus={() => warm(category, id)}
                      >
                        {PROVIDER_LABELS[id]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>

              <div className="w-full pt-8">
                {category === "mcp" && provider === "zeros" ? (
                  <CustomizeMcpSection
                    key={scopeKey}
                    scope={scope}
                    surfaceActive={surfaceActive}
                    onNew={() => setView({ kind: "form", index: null, owner })}
                    onEdit={(index) => setView({ kind: "form", index, owner })}
                    onSwitchToUser={() => setScope({ kind: "user" })}
                  />
                ) : (
                  <CustomizeExtensionsSection
                    key={owner}
                    query={query}
                    surfaceActive={surfaceActive}
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
