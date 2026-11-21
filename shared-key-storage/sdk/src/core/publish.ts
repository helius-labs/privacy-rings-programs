/**
 * The instructions a vault signs to publish a key record, for any wallet.
 * They depend only on the input, so an approver can build them again and
 * compare them with what it is asked to sign. The caller wraps them in the
 * instruction of the wallet program that signs for the vault. To remove the
 * record, use `removeRecordInstructions`.
 */
import type { Address, Instruction } from "@solana/kit";

import { encodeKeyRecord, type KeyRecord } from "../keyRecord.js";
import {
  registerVaultKeysInstruction,
  updateKeysInstruction,
} from "../registry.js";
import { publishRecordInstructions } from "../record/storage.js";

/**
 * Create: user registry `register` of the record's public keys, then the
 * first publication of the record uploaded at `upload`, which creates the
 * vault's storage pointer. The vault pays the rent of its registry record and
 * pointer, so it needs SOL. `register` fails once the vault is registered.
 */
export async function createKeyRecordInstructions(
  input: Readonly<{
    vault: Address;
    record: KeyRecord;
    /** The Record account holding `record`, frozen under the vault. */
    upload: Address;
  }>,
): Promise<Instruction[]> {
  const { vault, record, upload } = input;
  if (record.epoch !== 0n) {
    throw new Error(`the first key record is record 0, not ${record.epoch}`);
  }
  return [
    await registerVaultKeysInstruction(vault, record),
    ...(await publishRecordInstructions({
      owner: vault,
      upload,
      predecessor: undefined,
      bytes: encodeKeyRecord(record),
    })),
  ];
}

/**
 * Update: user registry `update_keys` to the record's shared viewing key,
 * then the publication of the record uploaded at `upload`, which rewrites the
 * pointer and closes `predecessor`. A change of the wallet's signers belongs
 * in the same transaction.
 */
export async function updateKeyRecordInstructions(
  input: Readonly<{
    vault: Address;
    record: KeyRecord;
    /** The Record account holding `record`, frozen under the vault. */
    upload: Address;
    /** The Record account of the key record this one replaces. */
    predecessor: Address;
  }>,
): Promise<Instruction[]> {
  const { vault, record, upload, predecessor } = input;
  return [
    await updateKeysInstruction(vault, record.sharedViewingPublicKey),
    ...(await publishRecordInstructions({
      owner: vault,
      upload,
      predecessor,
      bytes: encodeKeyRecord(record),
    })),
  ];
}
