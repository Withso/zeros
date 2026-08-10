import {
  Building2,
  Check,
  ChevronsUpDown,
  ExternalLink,
  LogIn,
  LogOut,
  Plus,
  Settings,
  UserRound,
} from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { shellOpenUrl } from "../../platform/app";
import { useAuth, type AuthStatus } from "../auth";
import { setActiveOrganizationSelection } from "./active-team";
import { organizationDashboardUrl } from "./organization-links";
import { useActiveOrganization, useOrganizations } from "./team-store";

const APP_BASE_URL =
  (import.meta.env.VITE_APP_BASE_URL as string | undefined) ||
  "https://app.zeros.build";

function openDashboard(
  options: Parameters<typeof organizationDashboardUrl>[1],
) {
  void shellOpenUrl(organizationDashboardUrl(APP_BASE_URL, options));
}

export function organizationSwitcherSessionActions(
  authStatus: AuthStatus,
): {
  showManagement: boolean;
  sessionAction: "sign-in" | "log-out" | null;
} {
  return authStatus === "authenticated"
    ? { showManagement: true, sessionAction: "log-out" }
    : {
        showManagement: false,
        sessionAction: authStatus === "unauthenticated" ? "sign-in" : null,
      };
}

export function OrganizationSwitcher({
  onOpenSettings,
  onOrganizationChanged,
}: {
  onOpenSettings?: () => void;
  onOrganizationChanged?: () => void;
}) {
  const { me, status: organizationStatus } = useOrganizations();
  const active = useActiveOrganization();
  const { email, status: authStatus, startBrowserSignIn, signOut } = useAuth();
  const sessionActions = organizationSwitcherSessionActions(authStatus);
  const organizations = sessionActions.showManagement
    ? (me?.organizations ?? me?.teams ?? [])
    : [];
  const label =
    active?.name?.trim() ||
    (organizationStatus === "loading" ? "Loading…" : "Personal");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="text-fg1 hover:bg-sidebar-bg-hover mb-2 h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-medium [&_svg]:size-3.5"
          aria-label="Switch organization"
        >
          <span className="bg-bg2-hover inline-flex size-5 shrink-0 items-center justify-center rounded-sm">
            {active?.isPersonal ? (
              <UserRound strokeWidth={1.5} />
            ) : (
              <Building2 strokeWidth={1.5} />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronsUpDown
            className="text-muted-fg shrink-0"
            strokeWidth={1.5}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-muted-fg truncate font-normal">
          {email ?? "Organizations"}
        </DropdownMenuLabel>
        {organizations.map((organization) => (
          <DropdownMenuItem
            key={organization.id}
            className="gap-2"
            onSelect={() => {
              setActiveOrganizationSelection(
                organization.id,
                organization.isPersonal,
              );
              onOrganizationChanged?.();
            }}
          >
            {organization.isPersonal ? <UserRound /> : <Building2 />}
            <span className="min-w-0 flex-1 truncate">
              {organization.name.trim() || "Personal"}
            </span>
            {organization.id === active?.id && <Check aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
        {sessionActions.showManagement && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => openDashboard({ action: "create-organization" })}
            >
              <Plus />
              <span>Create organization</span>
              <ExternalLink className="text-muted-fg ml-auto" />
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                openDashboard({
                  ...(active ? { organizationId: active.id } : {}),
                  section: active?.isPersonal ? "profile" : "general",
                })
              }
            >
              <Building2 />
              <span>
                {active?.isPersonal ? "Manage account" : "Manage organization"}
              </span>
              <ExternalLink className="text-muted-fg ml-auto" />
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        {onOpenSettings && (
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings />
            <span>Settings</span>
          </DropdownMenuItem>
        )}
        {sessionActions.sessionAction === "log-out" ? (
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut />
            <span>Log out</span>
          </DropdownMenuItem>
        ) : sessionActions.sessionAction === "sign-in" ? (
          <DropdownMenuItem onSelect={() => void startBrowserSignIn()}>
            <LogIn />
            <span>Sign in</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
