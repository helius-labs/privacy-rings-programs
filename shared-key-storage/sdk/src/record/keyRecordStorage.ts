/** Key records in Record accounts: typed upload and read on top of `storage.ts`. */
import type { Address, TransactionSigner } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  decodeKeyRecord,
  encodeKeyRecord,
  type KeyRecord,
} from "../keyRecord.js";
import {
  fetchPublishedRecord,
  prepareRecordUpload,
  type RecordUpload,
} from "./storage.js";

/** The vault's published key record, which the next publication replaces and closes. */
export interface KeyRecordPublication {
  /** The Record account holding the key record. */
  readonly address: Address;
  readonly record: KeyRecord;
}

/** The vault's published key record read through its storage pointer, if any. */
export async function fetchPublishedKeyRecord(
  client: SprClient,
  vault: Address,
): Promise<KeyRecordPublication | undefined> {
  const published = await fetchPublishedRecord(client.solanaRpc, vault);
  if (published === undefined) return undefined;
  return {
    address: published.address,
    record: decodeKeyRecord(published.bytes),
  };
}

/**
 * Prepare upload transactions; send each before submitting register or
 * rotate. `payer` funds the upload and gets the rent back only by sending
 * `closeInstruction` before the upload's last transaction; when a later
 * rotation closes the record, its rent goes to the vault.
 */
export function prepareKeyRecordUpload(
  input: Readonly<{
    owner: Address;
    payer: TransactionSigner;
    record: KeyRecord;
  }>,
): Promise<RecordUpload> {
  return prepareRecordUpload({
    ...input,
    bytes: encodeKeyRecord(input.record),
  });
}
