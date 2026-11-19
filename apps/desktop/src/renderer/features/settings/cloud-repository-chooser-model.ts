import type { CloudGithubRepositoryPage } from "@zeros/protocol/cloud-github-connection";

export type ChooserRepository = CloudGithubRepositoryPage["repositories"][number];

export const fullName = (repository: { owner: string; name: string }) =>
  `${repository.owner}/${repository.name}`;

export function repositoryOwners(
  repositories: readonly ChooserRepository[],
  isChosen: (repository: ChooserRepository) => boolean,
): Array<{ owner: string; chosen: number }> {
  const owners = new Map<string, { owner: string; chosen: number }>();
  for (const repository of repositories) {
    const key = repository.owner.toLowerCase();
    const row = owners.get(key) ?? { owner: repository.owner, chosen: 0 };
    if (isChosen(repository)) row.chosen++;
    owners.set(key, row);
  }
  return [...owners.values()].sort((a, b) =>
    a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()),
  );
}

export function githubRepositoryFromUrl(text: string): { owner: string; name: string } | null {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#].*)?$/i.exec(text.trim());
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

// Pasted URLs and search bypass the active owner filter.
export function chooserRows(
  repositories: readonly ChooserRepository[],
  query: string,
  owner: string | null,
): ChooserRepository[] {
  const pasted = githubRepositoryFromUrl(query);
  if (pasted)
    return repositories.filter((row) => fullName(row).toLowerCase() === fullName(pasted).toLowerCase());
  const text = query.trim().toLowerCase();
  if (text) return repositories.filter((row) => fullName(row).toLowerCase().includes(text));
  return owner === null
    ? [...repositories]
    : repositories.filter((row) => row.owner.toLowerCase() === owner.toLowerCase());
}
