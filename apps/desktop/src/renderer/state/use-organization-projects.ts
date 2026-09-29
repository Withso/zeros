import { useMemo } from "react";
import { useProjects } from "./use-projects";
import { getActiveOrganizationIdSnapshot, useActiveOrganization } from "../features/team/team-store";
import { filterProjectsForOrganization } from "../features/team/organization-capabilities";

/** Navigation catalogs are owner-scoped; runtime reconciliation and folder
 * lookup can still use useProjects' complete collection. */
export function useOrganizationProjects() {
  const { projects, refresh } = useProjects();
  const organization = useActiveOrganization();
  const confirmedId = getActiveOrganizationIdSnapshot();
  const visible = useMemo(() => filterProjectsForOrganization(projects, organization, confirmedId), [projects, organization, confirmedId]);
  return { projects: visible, refresh };
}
