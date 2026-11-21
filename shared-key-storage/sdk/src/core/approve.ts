/**
 * The checks an approver runs before co-signing a Register or Rotate, for any
 * wallet: the proposed key record and the proposed instructions.
 */
import type { Address, Instruction } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import { bytesEqual } from "../bytes.js";
import {
  checkKeyHistory,
  encodeKeyRecord,
  type KeyRecord,
} from "../keyRecord.js";
import { checkUploadedRecord } from "../record/storage.js";
import {
  fetchPublishedKeyRecord,
  type KeyRecordPublication,
} from "../record/keyRecordStorage.js";

/**
 * Checks a proposed key record against the vault's accounts: the upload at
 * `upload` is frozen under the vault and holds exactly `record`, and `record`
 * extends the vault's published record, read through the vault's storage
 * pointer. Before Register there is none, so `record` must be epoch 0.
 * Returns the published record.
 */
export async function checkProposedKeyRecord(
  input: Readonly<{
    client: SprClient;
    accountId: Address;
    vault: Address;
    record: KeyRecord;
    upload: Address;
  }>,
): Promise<KeyRecordPublication | undefined> {
  const { record } = input;
  if (record.settings !== input.accountId) {
    throw new Error(`the key record belongs to ${record.settings}`);
  }
  await checkUploadedRecord(
    input.client.solanaRpc,
    input.vault,
    input.upload,
    encodeKeyRecord(record),
  );
  const published = await fetchPublishedKeyRecord(input.client, input.vault);
  checkKeyHistory(record, published?.record);
  return published;
}

/**
 * Throws unless `proposed` holds exactly the `expected` instructions, in
 * order: the same programs, accounts, account roles and data. Both lists are
 * instructions as built. Instructions decompiled from a transaction message
 * have their account roles merged across the transaction and may not match.
 */
export function checkInstructionsMatch(
  expected: readonly Instruction[],
  proposed: readonly Instruction[],
): void {
  if (expected.length !== proposed.length) {
    throw new Error(
      `expected ${expected.length} instructions, got ${proposed.length}`,
    );
  }
  expected.forEach((instruction, index) => {
    const proposedInstruction = proposed.at(index);
    const accounts = instruction.accounts ?? [];
    const proposedAccounts = proposedInstruction?.accounts ?? [];
    if (
      proposedInstruction === undefined ||
      proposedInstruction.programAddress !== instruction.programAddress ||
      proposedAccounts.length !== accounts.length ||
      accounts.some(
        (account, position) =>
          account.address !== proposedAccounts.at(position)?.address ||
          account.role !== proposedAccounts.at(position)?.role,
      ) ||
      !bytesEqual(
        instruction.data ?? new Uint8Array(),
        proposedInstruction.data ?? new Uint8Array(),
      )
    ) {
      throw new Error(`instruction ${index} is not the expected instruction`);
    }
  });
}
