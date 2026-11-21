/** The next key record of a rotation, for any wallet. */
import type { Address } from "@solana/kit";
import { ViewingKey } from "@heliuslabs/spr/keypair";

import {
  buildKeyRecord,
  checkKeyHistory,
  recoverOldViewingKeys,
  recoverSharedSecrets,
  type KeyRecipient,
  type KeyRecord,
  type SharedSecrets,
} from "../keyRecord.js";
import { destroySecrets, type Member } from "./member.js";

/**
 * The key record after `record` for `recipients`: `rotator` recovers the
 * current secrets, then a new shared viewing key and the unchanged nullifier
 * secret are encrypted to the recipients, with every old viewing key.
 */
export function rotatedKeyRecord(
  input: Readonly<{
    accountId: Address;
    record: KeyRecord;
    rotator: Member;
    recipients: readonly KeyRecipient[];
  }>,
): KeyRecord {
  const { record } = input;
  const secrets = recoverSharedSecrets(
    record,
    input.rotator.signer.address,
    input.rotator.keypair,
  );
  const newSecrets: SharedSecrets = {
    viewingKey: ViewingKey.generate(),
    nullifierKey: secrets.nullifierKey,
  };
  let previousViewingKeys: ViewingKey[] = [];
  try {
    previousViewingKeys = recoverOldViewingKeys(record, secrets.viewingKey);
    const next = buildKeyRecord({
      settings: input.accountId,
      epoch: record.epoch + 1n,
      secrets: newSecrets,
      previousViewingKeys: [...previousViewingKeys, secrets.viewingKey],
      recipients: input.recipients,
    });
    checkKeyHistory(next, record);
    return next;
  } finally {
    previousViewingKeys.forEach((key) => key.destroy());
    newSecrets.viewingKey.destroy();
    destroySecrets(secrets);
  }
}
