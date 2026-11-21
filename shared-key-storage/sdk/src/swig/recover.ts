/** Recover the vault's viewing keys as a member of a Swig wallet. */
import type { Address } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import { recoverRecordKeys } from "../core/recover.js";
import type { Member, VaultSecrets } from "../core/member.js";
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
