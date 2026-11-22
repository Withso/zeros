export interface CloudWorkspaceTarget {
  organizationId: string;
  workspaceId: string;
}

const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_IDENTITY = new RegExp(`^${UUID}$`, "i");
const KEY = new RegExp(`^cloud://(${UUID})/(${UUID})(?:/(.*))?$`, "i");
const ID = new RegExp(`^cloud:(${UUID}):(${UUID}):(.+)$`, "i");

// This UI key namespaces cloud checkouts but is never a filesystem path; server IDs stay unchanged.
export function cloudWorkspaceKey(target: CloudWorkspaceTarget): string {
  const key = `cloud://${target.organizationId}/${target.workspaceId}`;
  if (
    !UUID_IDENTITY.test(target.organizationId) ||
    !UUID_IDENTITY.test(target.workspaceId)
  )
    throw new Error("Invalid cloud workspace identity");
  return key.toLowerCase();
}

export function parseCloudWorkspaceKey(
  value: unknown,
): (CloudWorkspaceTarget & { relativePath: string }) | null {
  if (typeof value !== "string") return null;
  const match = KEY.exec(value);
  if (!match) return null;
  const relativePath = match[3] ?? "";
  // These are lexical paths, not URLs. Never decode a slash or traversal into
  // an engine-owned path, and never fall back to the local host on rejection.
  if (
    relativePath.split("/").some((part) => part === ".." || part === ".") ||
    Array.from(relativePath).some(
      (char) => char === "\\" || char.charCodeAt(0) < 32,
    )
  ) {
    throw new Error("Invalid cloud workspace path");
  }
  return {
    organizationId: match[1].toLowerCase(),
    workspaceId: match[2].toLowerCase(),
    relativePath,
  };
}

export function cloudScopedId(
  target: CloudWorkspaceTarget,
  id: string,
): string {
  cloudWorkspaceKey(target);
  if (!id) throw new Error("Invalid cloud resource identity");
  return `cloud:${target.organizationId.toLowerCase()}:${target.workspaceId.toLowerCase()}:${encodeURIComponent(id)}`;
}

export function parseCloudScopedId(
  value: unknown,
): (CloudWorkspaceTarget & { id: string }) | null {
  if (typeof value !== "string") return null;
  const match = ID.exec(value);
  if (!match) return null;
  try {
    return {
      organizationId: match[1].toLowerCase(),
      workspaceId: match[2].toLowerCase(),
      id: decodeURIComponent(match[3]),
    };
  } catch {
    throw new Error("Invalid cloud resource identity");
  }
}

export function isCloudWorkspace(value: unknown): boolean {
  return typeof value === "string" && /^cloud:\/\//i.test(value);
}

/** Persisted catalog repository namespace; membership can become empty without
 * changing its backend owner. This is identity, never an access grant. */
export function isCloudRepositorySlug(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || /[\s\\]/.test(value)) return false;
  const prefix = new RegExp(`^cloud-${UUID}:`, "i").exec(value);
  if (!prefix) return false;
  const rest = value.slice(prefix[0].length);
  const separator = rest.indexOf(":");
  if (separator < 1) return false;
  const repository = rest.slice(separator + 1).split("/");
  return repository.length === 2 && repository.every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..");
}

/** A project group's namespace (`cloud-<organization>:project:<project id or
 * folder>`), the catalog's slug for a workspace of several repositories. */
export function isCloudProjectSlug(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^cloud-${UUID}:project:[A-Za-z0-9_.-]{1,100}$`, "i").test(value) && !/:project:\.{1,2}$/.test(value);
}

/** Any cloud catalog namespace: a repository's or a project group's. */
export function isCloudOwnedSlug(value: unknown): value is string {
  return isCloudRepositorySlug(value) || isCloudProjectSlug(value);
}

export function cloudTargetForValue(
  value: unknown,
): CloudWorkspaceTarget | null {
  const parsed = parseCloudWorkspaceKey(value) ?? parseCloudScopedId(value);
  if (!parsed && typeof value === "string" && /^cloud:/i.test(value)) {
    throw new Error("Invalid cloud workspace identity");
  }
  return parsed;
}
