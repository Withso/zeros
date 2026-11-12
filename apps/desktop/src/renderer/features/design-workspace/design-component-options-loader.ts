// PURPOSE: The Options section's code, loaded once a workspace has a
// component frame (warmed before any is selected) and shared by every caller.

let loading: Promise<typeof import("./design-component-options")> | null = null;

export function loadDesignComponentOptions(): Promise<typeof import("./design-component-options")> {
  loading ??= import("./design-component-options");
  return loading;
}
