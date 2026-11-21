/** Recover a member's vault secrets from a key record, for any wallet. */
import {
  recoverOldViewingKeys,
  recoverSharedSecrets,
  type KeyRecord,
} from "../keyRecord.js";
import { destroySecrets, type Member, type VaultSecrets } from "./member.js";

/**
 * Recovers `member`'s shared secrets from `record`, and the viewing keys of
 * every previous epoch, current first. All of these secrets are encrypted
 * into the latest key record, including for newly added signers. Their keys
 * open UTXOs the vault received before a rotate; the SDK's wallet sync tries
 * every viewing key it holds on each of the vault's outputs.
 */
export function recoverRecordKeys(
  record: KeyRecord,
  member: Member,
): VaultSecrets {
  const secrets = recoverSharedSecrets(
    record,
    member.signer.address,
    member.keypair,
  );
  const viewingKeys = [secrets.viewingKey.clone()];
  try {
    viewingKeys.push(
      ...recoverOldViewingKeys(record, secrets.viewingKey).reverse(),
    );
  } catch (error) {
    destroySecrets(secrets);
    viewingKeys.forEach((key) => key.destroy());
    throw error;
  }
  return { record, secrets, viewingKeys };
}

/**
 * Checks that `member`'s entry in `record` opens to keys matching the record,
 * including every old viewing key.
 */
export function checkEntryOpens(record: KeyRecord, member: Member): void {
  const { secrets, viewingKeys } = recoverRecordKeys(record, member);
  destroySecrets(secrets);
  viewingKeys.forEach((key) => key.destroy());
}
