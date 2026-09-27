import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  LaptopMinimal,
  LogIn,
  LogOut,
  Plus,
  Settings,
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
import type { OrganizationSummary } from "./control-plane";
import {
  desktopOrganizationChoices,
  PERSONAL_ORGANIZATION,
} from "./personal-organization";

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
  canCreateOrganization: boolean,
): {
  showManagement: boolean;
  showCreateOrganization: boolean;
  sessionAction: "sign-in" | "log-out" | null;
} {
  return authStatus === "authenticated"
    ? {
        showManagement: true,
        showCreateOrganization: canCreateOrganization,
        sessionAction: "log-out",
      }
    : {
        showManagement: false,
        showCreateOrganization: false,
        sessionAction: authStatus === "unauthenticated" ? "sign-in" : null,
      };
}

/** Device-local Personal is presented as "Local": its workspaces and chats
 * live on this machine. The selection id and model name stay unchanged. */
export const LOCAL_ORGANIZATION_LABEL = "Local";

export function organizationDisplayName(
  organization: Pick<OrganizationSummary, "isPersonal" | "name">,
): string {
  if (organization.isPersonal) return LOCAL_ORGANIZATION_LABEL;
  return organization.name.trim() || "Organization";
}

function OrganizationIcon({
  organization,
}: {
  organization: Pick<OrganizationSummary, "isPersonal"> | null;
}) {
  return organization?.isPersonal ? (
    <LaptopMinimal strokeWidth={1.5} />
  ) : (
    <Building2 strokeWidth={1.5} />
  );
}

export function OrganizationSwitcher({
  onOpenSettings,
  onOrganizationChanged,
}: {
  onOpenSettings?: () => void;
  onOrganizationChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const {
    organizations: availableOrganizations,
    me,
    status: organizationStatus,
  } = useOrganizations();
  const selected = useActiveOrganization();
  const { email, status: authStatus, startBrowserSignIn, signOut } = useAuth();
  const sessionActions = organizationSwitcherSessionActions(
    authStatus,
    me?.capabilities?.createOrganization === true,
  );
  const active = sessionActions.showManagement
    ? selected
    : PERSONAL_ORGANIZATION;
  const organizations = sessionActions.showManagement
    ? availableOrganizations
    : desktopOrganizationChoices(null);
  const label = active
    ? organizationDisplayName(active)
    : organizationStatus === "loading"
      ? "Loading…"
      : LOCAL_ORGANIZATION_LABEL;

  // Keep Escape deterministic when another Radix layer is completing its exit.
  // The switcher has no nested menus, so the visible root is always the target.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* Sized to its name, up to the sidebar's width; a long organization
          name truncates while the icon and trailing chevron stay whole. 4px
          of padding on every side (px-1 beside the primitive's py-1). */}
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="text-fg1 hover:bg-sidebar-bg-hover data-[state=open]:bg-sidebar-bg-hover [&_svg]:text-fg2 mb-2 h-7.5 w-fit max-w-full min-w-0 justify-start gap-2 rounded-md px-1 text-xs font-medium [&_svg]:shrink-0"
          aria-label="Switch organization"
        >
          <OrganizationIcon organization={active} />
          <span className="min-w-0 truncate text-left">{label}</span>
          <ChevronDown className="size-3" strokeWidth={1.5} />
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
            <OrganizationIcon organization={organization} />
            <span className="min-w-0 flex-1 truncate">
              {organizationDisplayName(organization)}
            </span>
            {organization.id === active?.id && <Check aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
        {sessionActions.showManagement && (
          <>
            <DropdownMenuSeparator />
            {sessionActions.showCreateOrganization && (
              <DropdownMenuItem
                onSelect={() =>
                  openDashboard({ action: "create-organization" })
                }
              >
                <Plus />
                <span>Create organization</span>
                <ArrowUpRight className="text-muted-fg ml-auto" />
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() =>
                openDashboard({
                  ...(active && !active.isPersonal
                    ? { organizationId: active.id }
                    : {}),
                  section: active?.isPersonal ? "profile" : "general",
                })
              }
            >
              <Building2 />
              <span>
                {active?.isPersonal ? "Manage account" : "Manage organization"}
              </span>
              <ArrowUpRight className="text-muted-fg ml-auto" />
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
