/**
 * Removes the key record of a private Squads smart account.
 *
 * 1. Assert that every member still recovers the shared keys.
 * 2. One transaction, co-signed by Alice and Bob: `executeTransactionSyncV2`
 *    has the vault close its current record and its pointer with the Record
 *    program's `CloseAccount`. The rent of both goes to the vault.
 * 3. Assert that the vault has no published record and that recovery fails.
 *
 * The vault stays in the user registry with its last viewing key, so anyone
 * who kept the keys can still read its balance. A member that did not keep
 * them cannot recover them any more.
 *
 * Run: pnpm smart-account-close <settings>
 */
import assert from "node:assert/strict";

import {
  fetchPublishedKeyRecord,
  type Member,
  removeRecordInstructions,
  storagePointerAddress,
} from "@heliuslabs/shared-key-storage";
import { fetchSettings } from "../helpers/smart-account/account.js";
import {
  executeTransactionSyncInstruction,
  vaultAddress,
} from "../helpers/smart-account/program.js";
import { recoverVaultKeys } from "../helpers/smart-account/recover.js";
import {
  addressArgument,
  assertMembersRecover,
  balance,
  connect,
  membersAmong,
  send,
} from "../common.js";

const settings = addressArgument("smart-account-close", "settings");

const session = await connect();
const { client, rpc, wallet, alice, bob } = session;
const vault = await vaultAddress(settings);
const current = await fetchPublishedKeyRecord(client, vault);
if (current === undefined) throw new Error(`${settings} has no key record`);
console.log(
  `record:   ${current.address} (key record ${current.record.epoch})`,
);
console.log(`pointer:  ${await storagePointerAddress(vault)}`);

// 1. Every member recovers the shared keys.
const { members } = membersAmong(
  session,
  (await fetchSettings(client, settings)).signers.map((signer) => signer.key),
);
const recover = (member: Member) =>
  recoverVaultKeys({ client, settings, member });
await assertMembersRecover({ members, expected: current.record, recover });

// 2. Close, approved by Alice and Bob.
const before = await balance(rpc, vault);
const close = await executeTransactionSyncInstruction({
  settings,
  approvers: [alice.signer, bob.signer],
  inner: await removeRecordInstructions({
    owner: vault,
    current: current.address,
  }),
});
console.log(`closed:   ${await send(rpc, wallet, [close])}`);

// 3. Nothing is published and nobody recovers.
assert.equal(await fetchPublishedKeyRecord(client, vault), undefined);
for (const member of members) {
  await assert.rejects(recover(member), /has no key record/);
}
console.log("no member can recover the keys from the vault any more");
console.log(
  `rent:     ${(await balance(rpc, vault)) - before} lamports returned to the vault ${vault}`,
);
