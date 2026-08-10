import type { ProviderBinding } from "@zeros/protocol/identities";

interface ProviderIdentityChat {
  id: string;
  agentId?: string | null;
  providerBinding?: ProviderBinding | null;
}

export interface ProviderIdentityClearRequest {
  chatId: string;
  agentId: string;
  resumeId: string;
}

/** Provider-identity clears are guarded, local-only preparatory writes. A
 * refusal or compare miss must not suppress the authoritative chat metadata
 * batch that follows. Return unconfirmed clears for diagnostics only; the
 * engine's same-agent upsert rule independently protects a newer binding. */
export async function persistChatRowsWithBestEffortIdentityClears<Row>(
  rows: Row[],
  identityClears: ProviderIdentityClearRequest[],
  clearProviderIdentity: (
    input: ProviderIdentityClearRequest,
  ) => Promise<boolean>,
  replaceRows: (rows: Row[]) => Promise<void>,
): Promise<ProviderIdentityClearRequest[]> {
  const clearResults = await Promise.all(
    identityClears.map(async (input) => {
      try {
        return (await clearProviderIdentity(input)) ? null : input;
      } catch {
        return input;
      }
    }),
  );

  // This is the authoritative write for titles, pins, archive state, and every
  // other chat field. Its own failure still rejects so the caller can roll the
  // optimistic mirror back and retry later.
  await replaceRows(rows);
  return clearResults.filter(
    (input): input is ProviderIdentityClearRequest => input !== null,
  );
}

/** Convert only a known same-provider binding → no-binding transition into the
 * explicit DB compare-and-clear operation. Ordinary null snapshots stay
 * harmless because the engine's bulk upsert preserves its newer identity. */
export function providerIdentityClearForTransition(
  previous: ProviderIdentityChat | null | undefined,
  next: ProviderIdentityChat,
): ProviderIdentityClearRequest | null {
  const binding = previous?.providerBinding;
  if (
    !binding ||
    next.providerBinding ||
    !next.agentId ||
    next.agentId !== previous?.agentId ||
    binding.providerId !== next.agentId
  ) {
    return null;
  }
  return {
    chatId: next.id,
    agentId: next.agentId,
    resumeId: binding.resumeId,
  };
}
