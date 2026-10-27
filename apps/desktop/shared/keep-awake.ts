/** Device preference; never synchronized to an organization or cloud worker. */
export interface KeepAwakePreferences {
  enabled: boolean;
  supported: boolean;
}

export const KEEP_AWAKE_ACTIVITY_REQUEST = "keep-awake-request-activity";
