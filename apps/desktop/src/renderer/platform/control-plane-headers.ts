export const SYNC_FIELD_HEADERS = { "X-Zeros-Sync": "1", "X-Zeros-Sync-Wanted": "1" } as const;
// The contract replay uses the same team-sharing headers as the app.
export const TEAM_SHARING_HEADERS = { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" } as const;
