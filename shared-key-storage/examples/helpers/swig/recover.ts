/** Recover the vault's viewing keys as a member of a Swig wallet. */
import type { Address } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  type Member,
  recoverRecordKeys,
  type VaultSecrets,
} from "@heliuslabs/shared-key-storage";
import { fetchCurrentSwigRecord, fetchSwig } from "./account.js";

/**
 * Recovers `member`'s shared secrets of the current key record and every old
 * viewing key, current first; see `recoverRecordKeys`.
 */
export async function recoverSwigVaultKeys(
  input: Readonly<{ client: SprClient; swig: Address; member: Member }>,
): Promise<VaultSecrets> {
  const { record } = await fetchCurrentSwigRecord(
    input.client,
    input.swig,
    await fetchSwig(input.client, input.swig),
  );
  return recoverRecordKeys(record, input.member);
}
