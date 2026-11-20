/**
 * Replaces the wallet's current record.
 *
 * 1. Read the current record and revision through the wallet's pointer.
 * 2. Upload the new bytes into a fresh Record account and freeze it under the
 *    wallet. The current record stays published during the upload.
 * 3. Publish in one transaction: rewrite the pointer with the next revision
 *    and the new hash, and close the old record, refunding its rent to the
 *    old record's refund destination.
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
console.log(`current:  ${current.address} (revision ${current.revision})`);

const prepared = await prepareRecordUpload({
  owner: wallet.address,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(rpc, wallet, prepared.transactions);

await checkUploadedRecord(rpc, wallet.address, prepared.address, bytes);
const balanceBefore = await balance(rpc, current.refund);
const publish = await publishRecordInstructions(rpc, {
  owner: wallet.address,
  upload: prepared,
  predecessor: current,
  bytes,
});
console.log(`published: ${await send(rpc, wallet, publish)}`);

const published = await fetchPublishedRecord(rpc, wallet.address);
if (published === undefined) throw new Error("record was not published");
console.log(`record:   ${published.address}`);
console.log(`revision: ${published.revision}`);
console.log(`content:  ${new TextDecoder().decode(published.bytes)}`);
const old = await fetchEncodedAccount(rpc, current.address, {
  commitment: "confirmed",
});
console.log(`old record closed: ${!old.exists}`);
// The wallet also paid the fee, so this is the refund minus that fee.
const change = (await balance(rpc, current.refund)) - balanceBefore;
console.log(
  `refund destination ${current.refund} changed by ${change} lamports`,
);
