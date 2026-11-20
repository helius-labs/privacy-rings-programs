/**
 * Creates a Squads smart account and publishes its first record. The smart
 * account's vault owns the record; your wallet is its only signer
 * (threshold 1) and pays for everything.
 *
 * 1. Create the smart account and fund its vault, which pays the pointer's
 *    rent.
 * 2. Upload: create a Record account, write the bytes in chunks, then hand
 *    its authority to the vault, which freezes the bytes.
 * 3. Publish: `executeTransactionSyncV2` has the vault create its pointer and
 *    write the record's address and hash into it.
 *
 * Run: pnpm smart-account-create [file]
 */
import {
  Permission,
  checkUploadedRecord,
  createSmartAccountInstruction,
  decodeProgramConfig,
  executeTransactionSyncInstruction,
  fetchPublishedRecord,
  prepareRecordUpload,
  programConfigAddress,
  publishRecordInstructions,
  settingsAddress,
  storagePointerAddress,
  vaultAddress,
} from "@heliuslabs/shared-key-storage";
import {
  accountData,
  recordBytes,
  send,
  setup,
  transferSol,
  upload,
} from "../common.js";

const { rpc, wallet } = await setup();
const bytes = await recordBytes(
  `Squads record 0, created ${new Date().toISOString()}`,
  process.argv[2],
);

// The Settings address comes from the Squads account counter, so another
// account created in between makes the create fail; run again then.
const config = decodeProgramConfig(
  await accountData(rpc, await programConfigAddress()),
);
const settings = await settingsAddress(config.smartAccountIndex + 1n);
const vault = await vaultAddress(settings);
const create = await createSmartAccountInstruction({
  creator: wallet,
  treasury: config.treasury,
  settings,
  signers: [{ key: wallet.address, permissions: Permission.All }],
  threshold: 1,
});
console.log(
  `created smart account ${settings}: ${await send(rpc, wallet, [
    create,
    transferSol(wallet, vault, 10_000_000n),
  ])}`,
);

const prepared = await prepareRecordUpload({
  owner: vault,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(rpc, wallet, prepared.transactions);

// Check the frozen upload, then publish it as the vault.
await checkUploadedRecord(rpc, vault, prepared.address, bytes);
const publish = await executeTransactionSyncInstruction({
  settings,
  approvers: [wallet],
  inner: await publishRecordInstructions({
    owner: vault,
    upload: prepared.address,
    predecessor: undefined,
    bytes,
  }),
});
console.log(`published: ${await send(rpc, wallet, [publish])}`);

const published = await fetchPublishedRecord(rpc, vault);
if (published === undefined) throw new Error("record was not published");
console.log(`settings: ${settings}`);
console.log(`vault:    ${vault}`);
console.log(`pointer:  ${await storagePointerAddress(vault)}`);
console.log(`record:   ${published.address}`);
console.log(`content:  ${new TextDecoder().decode(published.bytes)}`);
console.log(
  `next:     pnpm smart-account-rotate ${settings} add <signer address>`,
);
