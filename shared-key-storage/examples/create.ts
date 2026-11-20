/**
 * Publishes the wallet's first record on the SPL Record program.
 *
 * 1. Upload: create a Record account, write the bytes in chunks, then hand
 *    its authority to the wallet, which freezes the bytes.
 * 2. Publish: create the wallet's pointer at
 *    `createWithSeed(wallet, "key-record-pointer", Record)` and write the
 *    record's address and hash into it.
 *
 * Run: pnpm create-record [file]
 */
import {
  checkUploadedRecord,
  fetchPublishedRecord,
  prepareRecordUpload,
  publishRecordInstructions,
  storagePointerAddress,
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

const prepared = await prepareRecordUpload({
  owner: wallet.address,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(rpc, wallet, prepared.transactions);

// The owner checks the frozen upload, then publishes it. No predecessor:
// this is the first record for this owner.
await checkUploadedRecord(rpc, wallet.address, prepared.address, bytes);
const publish = await publishRecordInstructions({
  owner: wallet.address,
  upload: prepared.address,
  predecessor: undefined,
  bytes,
});
console.log(`published: ${await send(rpc, wallet, publish)}`);

const published = await fetchPublishedRecord(rpc, wallet.address);
if (published === undefined) throw new Error("record was not published");
console.log(`pointer:  ${await storagePointerAddress(wallet.address)}`);
console.log(`record:   ${published.address}`);
console.log(`content:  ${new TextDecoder().decode(published.bytes)}`);
