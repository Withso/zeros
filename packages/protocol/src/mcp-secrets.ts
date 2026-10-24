/** Opaque environment references keep per-server values out of provider argv. */
export function mcpSecretEnvAlias(credentialId: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credentialId) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error("Invalid MCP secret reference.");
  return `ZEROS_MCP_${credentialId.replaceAll("-", "").toUpperCase()}_${name}`;
}
