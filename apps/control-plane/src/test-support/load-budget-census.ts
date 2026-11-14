export const CENSUS_ROUTES = {
  workspace: { method: "GET", route: "/v1/cloud-v2/workspaces/:id" },
  list: { method: "GET", route: "/v1/cloud-v2/workspaces" },
  connections: { method: "GET", route: "/v1/cloud-v2/devices/:deviceId/connections" },
  heartbeat: { method: "POST", route: "/v1/cloud-v2/devices/:deviceId/heartbeat" },
  history: { method: "POST", route: "/v1/cloud-v2/workspaces/:id/history" },
  github: { method: "POST", route: "/v1/cloud-v2/workspaces/:id/github" },
  connect: { method: "POST", route: "/v1/cloud-v2/workspaces/:id/connect" },
  workspaceEvents: { method: "GET", route: "/v1/cloud-v2/workspaces/:id/events" },
  deviceEvents: { method: "GET", route: "/v1/cloud-v2/devices/:deviceId/events" },
  snapshot: { method: "GET", route: "/v1/auth/snapshot" },
  authEvents: { method: "GET", route: "/v1/auth/events" },
} as const;
export type CensusOperation = keyof typeof CENSUS_ROUTES;
export type CensusProfile = {
  name: "census-stopped" | "census-connected";
  state: "stopped" | "running";
  capturedAt: string;
  routes: readonly { operation: CensusOperation; requests: number; capturedTransactions: number }[];
  excluded: readonly { route: string; capturedTransactions: number; requests: null; reason: string }[];
};

export const CENSUS_CAPTURE = {
  build: 961,
  windowMs: 60_000,
  sourceSha256: "48b6beaa7f5d699c12269cbdade61caac4fce6e2ed5c4bec59ca66c72dada9a3",
  requestSource: "Authenticated HTTP counts from workos-authentication advisory-lock observations",
  scope: "Server cost at captured app request rates; producer frequency still requires the owner-app census",
  assumptions: [
    "Bodies and stream lifetimes were not captured; the following are assumed, not measured app behavior",
    "One activated organization workspace and one device; connected profile has one live client and no running turn",
    "Device registration uses legacy liveness with local-commands-v1 and local-commands-reason-v1; captured capabilities are unknown",
    "History reads messages.windowOlder before the newest of four mirrored rows, with limit 20",
    "GitHub uses gh.prSync with empty params, an authorized synthetic repository and no pull request",
    "Connect requests use wake:false and obtain tickets; they do not imply relay reconnects",
    "Requests are evenly spaced within the captured minute and compressed in CI",
    "Workspace streams reconnect sequentially; device/auth streams stay open until the window ends",
    "Auth events resume at the snapshot cursor; unknown worker HTTP counts are not fabricated",
    "Setup mutation notifications are stopped and joined before measurement; global maintenance is outside this route replay",
  ],
} as const;

export const CENSUS_PROFILES: readonly CensusProfile[] = [
  { name: "census-stopped", state: "stopped", capturedAt: "2026-11-14T03:15:28.469Z", routes: [
    { operation: "workspace", requests: 9, capturedTransactions: 27 },
    { operation: "list", requests: 4, capturedTransactions: 12 },
    { operation: "connections", requests: 3, capturedTransactions: 6 },
    { operation: "heartbeat", requests: 2, capturedTransactions: 4 },
  ], excluded: [
    { route: "GET /v1/release-identity", capturedTransactions: 4, requests: null, reason: "Build watchers, outside app traffic" },
  ] },
  { name: "census-connected", state: "running", capturedAt: "2026-11-14T03:33:09.783Z", routes: [
    { operation: "workspace", requests: 13, capturedTransactions: 39 },
    { operation: "history", requests: 8, capturedTransactions: 18 },
    { operation: "github", requests: 5, capturedTransactions: 14 },
    { operation: "connections", requests: 4, capturedTransactions: 8 },
    { operation: "list", requests: 2, capturedTransactions: 6 },
    { operation: "connect", requests: 2, capturedTransactions: 16 },
    { operation: "workspaceEvents", requests: 2, capturedTransactions: 4 },
    { operation: "heartbeat", requests: 2, capturedTransactions: 3 },
    { operation: "snapshot", requests: 1, capturedTransactions: 3 },
    { operation: "deviceEvents", requests: 1, capturedTransactions: 2 },
    { operation: "authEvents", requests: 1, capturedTransactions: 1 },
  ], excluded: [
    { route: "POST /v2/cloud/worker/prompts/pull", capturedTransactions: 12, requests: null, reason: "HTTP count and pull bodies unknown" },
    { route: "POST /v2/cloud/worker/execution-leases/renew", capturedTransactions: 25, requests: null, reason: "HTTP count and context batch sizes unknown; R2" },
  ] },
];

export function censusSchedule(profile: CensusProfile) {
  return profile.routes.flatMap(({ operation, requests }) => Array.from({ length: requests }, (_, index) =>
    ({ operation, at: Math.floor(index * CENSUS_CAPTURE.windowMs / requests) })))
    .sort((left, right) => left.at - right.at);
}

export function censusCaptureTable() {
  return CENSUS_PROFILES.flatMap(profile => [
    ...profile.routes.map(row => ({ scenario: profile.name, ...CENSUS_ROUTES[row.operation],
      requests: row.requests, capturedTransactions: row.capturedTransactions, replayed: true, reason: "Observed authenticated app requests" })),
    ...profile.excluded.map(({ route, ...row }) => ({ scenario: profile.name, method: route.split(" ")[0]!,
      route: route.slice(route.indexOf(" ") + 1), ...row, replayed: false })),
  ]);
}
