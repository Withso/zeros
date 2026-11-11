import { Avatar, AvatarFallback, AvatarImage } from "@/renderer/shared/ui/primitives/avatar";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { initialsOf } from "@/renderer/shared/lib/initials";
import { cn } from "../shared/ui/cn";
import { saveDashboardBy, useDashboardBy, type DashboardBy } from "../features/dashboard/preferences";
import { useOrganizationRoster } from "../state/organization-roster";

/** Team sharing: every member of the organization, with or without
 * workspaces. A person opens Home filtered to the workspaces they run. */
export function SidebarTeamSection({
  organizationId,
  me,
  active,
  onHome,
  homeActive,
  entryClassName,
  labelClassName,
}: {
  organizationId: string;
  me: string | null;
  active: boolean;
  onHome: () => void;
  homeActive: boolean;
  entryClassName: string;
  labelClassName: string;
}) {
  const roster = useOrganizationRoster(organizationId, active);
  const by = useDashboardBy(organizationId);
  if (!roster?.length) return null;
  // The viewer first, then teammates by name.
  const people = [...roster].sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name));
  return (
    <div role="group" aria-label="Team" className="flex flex-col gap-0.5" data-sidebar-team="">
      <div className={cn(labelClassName, "px-2 pt-3 pb-1")}>Team</div>
      {people.map((person) => {
        const value: DashboardBy = person.id === me ? "me" : `user:${person.id}`;
        const selected = homeActive && by === value;
        return (
          <Button
            key={person.id}
            type="button"
            variant="ghost"
            className={entryClassName}
            data-state={selected ? "active" : "inactive"}
            aria-current={selected ? "page" : undefined}
            aria-label={`Workspaces by ${person.id === me ? "you" : person.name}`}
            onClick={() => {
              saveDashboardBy(organizationId, value);
              onHome();
            }}
          >
            {/* A 20px avatar pulled into the rows' 16px icon column. */}
            <Avatar size="xs" className="-mx-0.5" aria-hidden="true">
              {person.avatarUrl && <AvatarImage src={person.avatarUrl} alt="" referrerPolicy="no-referrer" />}
              <AvatarFallback>{initialsOf(person.name)}</AvatarFallback>
            </Avatar>
            <span className="truncate">{person.id === me ? `${person.name} (you)` : person.name}</span>
          </Button>
        );
      })}
    </div>
  );
}
