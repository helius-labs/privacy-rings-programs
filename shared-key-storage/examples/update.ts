/**
 * Replaces the wallet's current record.
 *
 * 1. Read the current record and revision from the head.
 * 2. Upload the new bytes into a fresh buffer. The current record stays
 *    active during the upload.
 * 3. Apply the buffer: in one instruction the program seals it, advances the
 *    head and revision, closes the old record and refunds its rent to the
 *    old record's refund destination.
 *
 * Run: pnpm update-record [file]
 */
import {
  applyRecordInstruction,
  fetchPublishedRecord,
  prepareRecordUpload,
} from "@heliuslabs/shared-key-storage";
import { recordBytes, send, setup, upload } from "./common.js";

const { client, wallet } = await setup();
const bytes = await recordBytes(`record updated ${new Date().toISOString()}`);

const current = await fetchPublishedRecord(client, wallet.address);
if (current === undefined) {
  throw new Error(`${wallet.address} has no record; run pnpm create-record`);
}
console.log(`current:  ${current.address} (revision ${current.revision})`);

// The buffer names its predecessor; apply fails if the head moved since.
const prepared = await prepareRecordUpload({
  owner: wallet.address,
  previous: current.address,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(client, wallet, prepared.instructions);

const balanceBefore = await client.getBalance(current.refund);
const apply = await applyRecordInstruction(
  wallet.address,
  prepared.address,
  current,
  bytes,
);
console.log(`applied: ${await send(client, wallet, [apply])}`);

const published = await fetchPublishedRecord(client, wallet.address);
if (published === undefined) throw new Error("record was not published");
console.log(`record:   ${published.address}`);
console.log(`revision: ${published.revision}`);
console.log(`content:  ${new TextDecoder().decode(published.bytes)}`);
const closed = (await client.getAccount(current.address)) === undefined;
console.log(`old record closed: ${closed}`);
// The wallet also paid the fee, so this is the refund minus that fee.
const change = (await client.getBalance(current.refund)) - balanceBefore;
console.log(
  `refund destination ${current.refund} changed by ${change} lamports`,
);
