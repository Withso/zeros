export type RemovalOptions = { container: string; root: string; kind?: "directory" | "file" };
export function refusal(target: string, options: RemovalOptions): string | null;
export function removeContained(target: string, options: RemovalOptions): "removed" | string;
export function refusalAsync(target: string, options: RemovalOptions): Promise<string | null>;
export function removeContainedAsync(target: string, options: RemovalOptions): Promise<"removed" | string>;
