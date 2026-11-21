/** Recover the vault's viewing keys as a member of a Squads smart account. */
import type { Address } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  type Member,
  recoverRecordKeys,
  type VaultSecrets,
} from "@heliuslabs/shared-key-storage";
import { fetchCurrentKeyRecord, fetchSettings } from "./account.js";

/**
 * Recovers the shared secrets of the current key record, and the viewing
 * keys of every previous epoch, current first; see `recoverRecordKeys`.
 */
export async function recoverVaultKeys(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    member: Member;
  }>,
): Promise<VaultSecrets> {
  const { record } = await fetchCurrentKeyRecord(
    input.client,
    input.settings,
    await fetchSettings(input.client, input.settings),
  );
  return recoverRecordKeys(record, input.member);
}
