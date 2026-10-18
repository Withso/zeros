declare module "*/scripts/generate-types.mjs" {
  export interface ContractSchemas {
    openApi: Record<string, unknown>;
    deviceStream: Record<string, unknown>;
    runtimeAuth: Record<string, unknown>;
  }
  export function loadContractSchemas(doc?: URL): ContractSchemas;
  export function generateRestTypes(openApi: Record<string, unknown>): string;
  export function generateDeviceStreamTypes(schema: Record<string, unknown>): string;
  export function generateRuntimeAuthTypes(schema: Record<string, unknown>): string;
  export function main(argv?: string[]): void;
}
