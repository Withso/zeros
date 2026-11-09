// An organization's slug is the owner segment of its workspace pages and
// links (`app.zeros.build/<slug>/w/<n>`). These would be another product route,
// Local's own owner or a link action, so a new organization never gets one
// bare. Dependency-free: @zeros/protocol mirrors the list as
// RESERVED_WORKSPACE_LINK_OWNERS and scripts/__tests__/workspace-link-owners
// keeps the two equal.
export const RESERVED_ORGANIZATION_SLUGS: ReadonlySet<string> = new Set([
  "agents", "api", "assets", "auth", "chat", "cloud-workspace", "github",
  "invite", "local", "open", "personal", "schemas", "w", "workspace",
]);
