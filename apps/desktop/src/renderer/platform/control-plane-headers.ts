// Opt-in request headers shared by cloudAccountRequest and the control-plane
// client contract, so the contract replays exactly what this app sends.
export const SYNC_FIELD_HEADERS = { "X-Zeros-Sync": "1", "X-Zeros-Sync-Wanted": "1" } as const;
export const TEAM_SHARING_HEADERS = { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" } as const;
