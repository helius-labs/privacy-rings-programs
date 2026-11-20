/**
 * Adds or removes a Squads signer and replaces the smart account's record, in
 * one transaction. Your wallet must be able to approve alone: a signer with
 * every permission on a threshold-1 account, as `smart-account-create` makes. Added
 * signers may only vote, so your wallet stays the one that initiates and
 * executes.
 *
 * 1. Upload the new bytes into a fresh Record account, frozen under the
 *    vault. The current record stays published meanwhile.
 * 2. One transaction: `executeTransactionSyncV2` points the pointer at the
 *    new record and closes the old one, whose rent goes to the vault; then
 *    `executeSettingsTransactionSync` adds or removes the signer.
 *
 * Run: pnpm smart-account-rotate <settings> add|remove <signer address> [file]
 */
import { address } from "@solana/kit";
import {
  Permission,
  checkSyncConsensus,
  checkUploadedRecord,
  decodeSettings,
  executeSettingsTransactionSyncInstruction,
  executeTransactionSyncInstruction,
  fetchPublishedRecord,
  prepareRecordUpload,
  publishRecordInstructions,
  rotationActions,
  vaultAddress,
} from "@heliuslabs/shared-key-storage";
import { accountData, recordBytes, send, setup, upload } from "../common.js";

const [settingsArgument, action, signerArgument, file] = process.argv.slice(2);
if (
  settingsArgument === undefined ||
  (action !== "add" && action !== "remove") ||
  signerArgument === undefined
) {
  throw new Error(
    "usage: pnpm smart-account-rotate <settings> add|remove <signer> [file]",
  );
}
const settings = address(settingsArgument);
const signer = address(signerArgument);

const { rpc, wallet } = await setup();
const current = decodeSettings(await accountData(rpc, settings));
// Throws unless the wallet alone meets the threshold and permissions.
checkSyncConsensus(current, [wallet.address]);
const isSigner = current.signers.some((entry) => entry.key === signer);
if (action === "add" && isSigner) throw new Error(`${signer} is a signer`);
if (action === "remove" && !isSigner) {
  throw new Error(`${signer} is not a signer`);
}
if (signer === wallet.address) throw new Error("the wallet must stay a signer");
const next =
  action === "add"
    ? [...current.signers, { key: signer, permissions: Permission.Vote }]
    : current.signers.filter((entry) => entry.key !== signer);

const vault = await vaultAddress(settings);
const published = await fetchPublishedRecord(rpc, vault);
if (published === undefined) {
  throw new Error(`${settings} has no record; run pnpm smart-account-create`);
}
console.log(`current:  ${published.address}`);

const bytes = await recordBytes(
  `Squads record after ${action} ${signer}, ${new Date().toISOString()}`,
  file,
);
const prepared = await prepareRecordUpload({
  owner: vault,
  payer: wallet,
  bytes,
});
console.log(`uploading ${bytes.length} bytes to ${prepared.address}`);
await upload(rpc, wallet, prepared.transactions);
await checkUploadedRecord(rpc, vault, prepared.address, bytes);

const publish = await executeTransactionSyncInstruction({
  settings,
  approvers: [wallet],
  inner: await publishRecordInstructions({
    owner: vault,
    upload: prepared.address,
    predecessor: published.address,
    bytes,
  }),
});
const membership = executeSettingsTransactionSyncInstruction({
  settings,
  rentPayer: wallet,
  approvers: [wallet],
  actions: rotationActions(current, next, current.threshold),
});
console.log(`rotated: ${await send(rpc, wallet, [publish, membership])}`);

const record = await fetchPublishedRecord(rpc, vault);
if (record === undefined) throw new Error("record was not published");
console.log(`record:   ${record.address}`);
console.log(`content:  ${new TextDecoder().decode(record.bytes)}`);
console.log("signers:");
for (const entry of decodeSettings(await accountData(rpc, settings)).signers) {
  console.log(`  ${entry.key} (permissions ${entry.permissions})`);
}
