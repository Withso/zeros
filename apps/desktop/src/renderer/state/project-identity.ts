// A project is one GitHub repository that may have folders on this Mac, a
// cloud repository, or both. The join is derived on every read from what each
// side already stores; it is never persisted, and no side's ID changes.

import { isGithubDotComRemote, parseRemote } from "../shell/pr/github-url";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import type { Project } from "./projects-store";

export type ProjectPlace = "local" | "cloud";

export interface ProjectSide {
  /** The side's own stable ID (a local project ID, a cloud repository key). */
  id: string;
  place: ProjectPlace;
  /** A Git remote URL, or `owner/name` for a GitHub repository. */
  remote: string | null;
  /** GitHub's repository ID when this side knows it. */
  githubId?: string | null;
  /** Earlier is preferred as the default local folder. */
  addedAt?: number;
}

export interface JoinedProject<T extends ProjectSide = ProjectSide> {
  /** Stable while the repository's identity is unchanged: `github:owner/name`
   * for a GitHub repository, else `<place>:<side id>`. */
  key: string;
  repository: { owner: string; name: string } | null;
  local: readonly T[];
  cloud: readonly T[];
  /** The folder new workspaces use: the earliest added, then the lowest ID. */
  defaultLocal: T | null;
}

export interface ProjectJoin<T extends ProjectSide = ProjectSide> {
  projects: readonly JoinedProject<T>[];
  bySide: ReadonlyMap<string, JoinedProject<T>>;
}

/** GitHub.com only; Enterprise and other forges never join. Owner and name are
 * compared case-insensitively, so they are returned lowercased. */
export function githubRepository(remote: string | null | undefined): { owner: string; name: string } | null {
  if (!remote) return null;
  const value = remote.trim();
  const url = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? `https://github.com/${value}` : value;
  if (!isGithubDotComRemote(url)) return null;
  const parsed = parseRemote(url);
  if (!parsed?.owner || !parsed.repo) return null;
  return { owner: parsed.owner.toLowerCase(), name: parsed.repo.toLowerCase() };
}

function byDefault<T extends ProjectSide>(a: T, b: T): number {
  return (a.addedAt ?? Infinity) - (b.addedAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const cache = new WeakMap<readonly ProjectSide[], ProjectJoin>();
let previous = new Map<string, JoinedProject>();
let previousResult: ProjectJoin | null = null;

function sameSides(a: readonly ProjectSide[], b: readonly ProjectSide[]): boolean {
  return a.length === b.length && a.every((side, index) => side === b[index]);
}

/**
 * Sides join when they name the same GitHub repository. GitHub's ID decides
 * once both sides know it: the same ID joins across a rename, and two different
 * IDs never join even under one name. A side whose ID is unknown joins the
 * name's first group. A folder without a GitHub remote stays on its own.
 */
export function joinProjects<T extends ProjectSide>(sides: readonly T[]): ProjectJoin<T> {
  const cached = cache.get(sides);
  if (cached) return cached as ProjectJoin<T>;
  type Group = { sides: T[]; ids: Set<string>; repository: { owner: string; name: string } | null; key: string };
  const groups: Group[] = [];
  const byId = new Map<string, Group>();
  const byName = new Map<string, Group[]>();
  for (const side of sides) {
    const repository = githubRepository(side.remote);
    const id = side.githubId?.trim() || null;
    const name = repository ? `${repository.owner}/${repository.name}` : null;
    let group = id ? byId.get(id) : undefined;
    if (!group && name)
      group = byName.get(name)?.find(candidate => !id || candidate.ids.size === 0 || candidate.ids.has(id));
    if (!group) {
      group = { sides: [], ids: new Set(), repository, key: name ? `github:${name}` : `${side.place}:${side.id}` };
      if (name && byName.has(name)) group.key = `github:${name}#${id ?? side.id}`;
      groups.push(group);
      if (name) byName.set(name, [...(byName.get(name) ?? []), group]);
    }
    group.sides.push(side);
    if (id) {
      group.ids.add(id);
      byId.set(id, group);
    }
  }
  const next = new Map<string, JoinedProject>();
  const projects = groups.map((group): JoinedProject<T> => {
    const local = group.sides.filter(side => side.place === "local").sort(byDefault);
    const cloud = group.sides.filter(side => side.place === "cloud");
    const old = previous.get(group.key) as JoinedProject<T> | undefined;
    const joined = old && sameSides(old.local, local) && sameSides(old.cloud, cloud) &&
      old.repository?.owner === group.repository?.owner && old.repository?.name === group.repository?.name
      ? old
      : { key: group.key, repository: group.repository, local, cloud, defaultLocal: local[0] ?? null };
    next.set(group.key, joined);
    return joined;
  });
  previous = next;
  if (previousResult && previousResult.projects.length === projects.length &&
      previousResult.projects.every((project, index) => project === projects[index])) {
    cache.set(sides, previousResult);
    return previousResult as ProjectJoin<T>;
  }
  const bySide = new Map<string, JoinedProject<T>>();
  for (const project of projects) for (const side of [...project.local, ...project.cloud]) bySide.set(side.id, project);
  const result: ProjectJoin<T> = { projects, bySide };
  cache.set(sides, result as ProjectJoin);
  previousResult = result as ProjectJoin;
  return result;
}

export type RegisteredProjectSide = ProjectSide & { project: Project };

const sideOf = new WeakMap<Project, RegisteredProjectSide>();
const sidesOf = new WeakMap<readonly Project[], readonly RegisteredProjectSide[]>();

/** Registered local folders and the cloud catalog's repositories, joined. */
export function joinRegisteredProjects(projects: readonly Project[]): ProjectJoin<RegisteredProjectSide> {
  let sides = sidesOf.get(projects);
  if (!sides) {
    sides = projects.map(project => {
      let side = sideOf.get(project);
      if (!side) {
        side = {
          id: project.id,
          place: isCloudWorkspace(project.repoRoot) ? "cloud" : "local",
          remote: project.originUrl,
          addedAt: project.addedAt,
          project,
        };
        sideOf.set(project, side);
      }
      return side;
    });
    sidesOf.set(projects, sides);
  }
  return joinProjects(sides);
}
