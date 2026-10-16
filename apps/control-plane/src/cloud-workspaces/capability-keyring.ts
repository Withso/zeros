export type CapabilityKeyring = {
  keys: Readonly<Record<number, string>>;
  currentKeyVersion: number;
};

/** The capability signing keyring is a dedicated keyring
 * (CLOUD_CAPABILITY_KEYS_JSON / CLOUD_CAPABILITY_CURRENT_KEY_VERSION):
 * security.md forbids reusing the settings-secret keyring for another
 * domain. Values are 32-byte canonical base64url keys. */
export function loadCapabilityKeyring(env: NodeJS.ProcessEnv): CapabilityKeyring | undefined {
  const encoded = env.CLOUD_CAPABILITY_KEYS_JSON;
  const current = env.CLOUD_CAPABILITY_CURRENT_KEY_VERSION;
  if (!encoded && !current) return undefined;
  const fail = (detail: string): never => {
    throw new Error(`Invalid cloud capability keyring: ${detail}`);
  };
  if (!encoded || encoded.length > 4096 || !current || !/^[1-9][0-9]{0,4}$/.test(current)) {
    fail("CLOUD_CAPABILITY_KEYS_JSON and CLOUD_CAPABILITY_CURRENT_KEY_VERSION are required together");
  }
  let document: unknown;
  try {
    document = JSON.parse(encoded!);
  } catch {
    fail("CLOUD_CAPABILITY_KEYS_JSON must be a JSON object");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("CLOUD_CAPABILITY_KEYS_JSON must be a JSON object");
  }
  const entries = Object.entries(document as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 32) fail("CLOUD_CAPABILITY_KEYS_JSON must contain 1 to 32 key versions");
  const keys: Record<number, string> = {};
  for (const [rawVersion, value] of entries) {
    if (!/^[1-9][0-9]{0,4}$/.test(rawVersion) || Number(rawVersion) > 65535) {
      fail(`CLOUD_CAPABILITY_KEYS_JSON contains an invalid key version`);
    }
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
      fail(`CLOUD_CAPABILITY_KEYS_JSON.${rawVersion} must be canonical base64url for exactly 32 bytes`);
    }
    const encodedKey = value as string;
    const bytes = Buffer.from(encodedKey, "base64url");
    try {
      if (bytes.length !== 32 || bytes.toString("base64url") !== encodedKey) {
        fail(`CLOUD_CAPABILITY_KEYS_JSON.${rawVersion} must be canonical base64url for exactly 32 bytes`);
      }
    } finally {
      bytes.fill(0);
    }
    keys[Number(rawVersion)] = encodedKey;
  }
  const currentKeyVersion = Number(current);
  if (!keys[currentKeyVersion]) fail("the current key version is not present in the keyring");
  return { keys, currentKeyVersion };
}
