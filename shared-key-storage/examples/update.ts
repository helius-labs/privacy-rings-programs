/**
 * Replaces the wallet's current record.
 *
 * 1. Read the current record through the wallet's pointer.
 * 2. Upload the new bytes into a fresh Record account and freeze it under the
 *    wallet. The current record stays published during the upload.
 * 3. Publish in one transaction: write the new record's address and hash
 *    into the pointer and close the old record, whose rent goes to the
 *    wallet.
 *
 * Run: pnpm update-record [file]
 */
import { fetchEncodedAccount } from "@solana/kit";
import {
  checkUploadedRecord,
  fetchPublishedRecord,
  prepareRecordUpload,
  publishRecordInstructions,
} from "@heliuslabs/shared-key-storage";
import { balance, recordBytes, send, setup, upload } from "./common.js";

const { rpc, wallet } = await setup();
const bytes = await recordBytes(`record updated ${new Date().toISOString()}`);

const current = await fetchPublishedRecord(rpc, wallet.address);
if (current === undefined) {
  throw new Error(`${wallet.address} has no record; run pnpm create-record`);
}
console.log(`current:  ${current.address}`);

const prepared = await prepareRecordUpload({
  owner: wallet.address,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(rpc, wallet, prepared.transactions);

await checkUploadedRecord(rpc, wallet.address, prepared.address, bytes);
const oldRent = await balance(rpc, current.address);
const balanceBefore = await balance(rpc, wallet.address);
const publish = await publishRecordInstructions({
  owner: wallet.address,
  upload: prepared.address,
  predecessor: current.address,
  bytes,
});
console.log(`published: ${await send(rpc, wallet, publish)}`);

const published = await fetchPublishedRecord(rpc, wallet.address);
if (published === undefined) throw new Error("record was not published");
console.log(`record:   ${published.address}`);
console.log(`content:  ${new TextDecoder().decode(published.bytes)}`);
const old = await fetchEncodedAccount(rpc, current.address, {
  commitment: "confirmed",
});
console.log(`old record closed: ${!old.exists}`);
// The wallet received the old record's rent and paid the transaction fee.
const change = (await balance(rpc, wallet.address)) - balanceBefore;
console.log(`old record's rent: ${oldRent} lamports`);
console.log(`wallet balance changed by ${change} lamports`);
