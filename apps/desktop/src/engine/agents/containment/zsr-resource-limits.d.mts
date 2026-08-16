export const ZSR_RESOURCE_LIMITS: Readonly<{
  processes: number;
  openFiles: number;
  coreBytes: number;
}>;

export function resourceLimitShell(): string;
