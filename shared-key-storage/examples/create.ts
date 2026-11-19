/**
 * Publishes the wallet's first record.
 *
 * 1. Upload the bytes in chunks into a fresh buffer account.
 * 2. Apply the buffer: the program creates the head PDA `[b"head", wallet]`,
 *    seals the buffer and points the head at it with revision 1.
 *
 * Run: pnpm create-record [file]
 */
import {
  EMPTY_RECORD_ADDRESS,
  applyRecordInstruction,
  fetchPublishedRecord,
  prepareRecordUpload,
  storageHeadAddress,
} from "@heliuslabs/shared-key-storage";
import { recordBytes, send, setup, upload } from "./common.js";

const { rpc, wallet } = await setup();
const bytes = await recordBytes(
  `record 0, created ${new Date().toISOString()}`,
);

if ((await fetchPublishedRecord(rpc, wallet.address)) !== undefined) {
  throw new Error(
    `${wallet.address} already has a record; run pnpm update-record`,
  );
}

// No predecessor: this is the first record for this owner.
const prepared = await prepareRecordUpload({
  owner: wallet.address,
  previous: EMPTY_RECORD_ADDRESS,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(rpc, wallet, prepared.instructions);

// The owner signs apply, which binds the hash of exactly these bytes.
const apply = await applyRecordInstruction(
  wallet.address,
  prepared.address,
  undefined,
  bytes,
);
console.log(`applied: ${await send(rpc, wallet, [apply])}`);

const published = await fetchPublishedRecord(rpc, wallet.address);
if (published === undefined) throw new Error("record was not published");
console.log(`head:     ${await storageHeadAddress(wallet.address)}`);
console.log(`record:   ${published.address}`);
console.log(`revision: ${published.revision}`);
console.log(`content:  ${new TextDecoder().decode(published.bytes)}`);
