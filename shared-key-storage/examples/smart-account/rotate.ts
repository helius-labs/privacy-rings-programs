/**
 * Rotates a private Squads smart account: replaces its third member and its
 * shared viewing key in one transaction. Carol leaves and Dave joins, or the
 * other way round if Dave is the member.
 *
 * 1. Alice, the rotator, recovers the current keys and builds the next key
 *    record: a new shared viewing key for Alice, Bob and the joining member,
 *    with every earlier viewing key. Alice's and Bob's viewing keys come
 *    from the user registry.
 * 2. Upload the record and freeze it under the vault. The current record
 *    stays published meanwhile.
 * 3. Alice and Bob each check the upload, the key history, their own entry
 *    and the instructions against the rotation they agree to.
 * 4. One transaction: `executeTransactionSyncV2` has the vault set the new
 *    viewing key in the user registry, publish the new record and close the
 *    old one; `executeSettingsTransactionSync` swaps the signer.
 * 5. Assert that the three members recover the new keys, including the old
 *    viewing key, and that the member that left does not.
 *
 * Run: pnpm smart-account-rotate <settings>
 */
import { fetchSettings } from "../helpers/smart-account/account.js";
import { Permission } from "../helpers/smart-account/program.js";
import { recoverVaultKeys } from "../helpers/smart-account/recover.js";
import {
  checkRotation,
  rotateSmartAccount,
} from "../helpers/smart-account/rotate.js";
import {
  addressArgument,
  assertMembersRecover,
  connect,
  ensureRegistered,
  membersAmong,
  recipient,
  send,
  sendUpload,
} from "../common.js";

const settings = addressArgument("smart-account-rotate", "settings");

const session = await connect();
const { client, rpc, wallet, alice, bob, carol, dave } = session;
const current = await fetchSettings(client, settings);
const { members } = membersAmong(
  session,
  current.signers.map((signer) => signer.key),
);
const [leaving, joining] = members.includes(carol)
  ? [carol, dave]
  : [dave, carol];
if (![alice, bob, leaving].every((member) => members.includes(member))) {
  throw new Error(`${settings} is not an account of smart-account-create`);
}
console.log(`${leaving.name} leaves, ${joining.name} joins`);
await ensureRegistered(session, joining);

// 1. Build the next key record.
const approvers = [alice, bob];
const keep = [alice.signer.address, bob.signer.address];
const added = { ...recipient(joining), permissions: Permission.All };
const rotation = await rotateSmartAccount({
  client,
  settings,
  rotator: alice,
  payer: wallet,
  approvers: approvers.map((approver) => approver.signer),
  keep,
  add: [added],
  threshold: current.threshold,
});
const { record } = rotation;

// 2. Upload.
await sendUpload(session, rotation.upload);

// 3. Alice and Bob check the rotation.
for (const approver of approvers) {
  await checkRotation({
    client,
    settings,
    record,
    upload: rotation.upload.address,
    member: approver,
    approvers: approvers.map((each) => each.signer.address),
    rentPayer: alice.signer.address,
    keep,
    add: [{ key: added.key, permissions: added.permissions }],
    threshold: current.threshold,
    proposed: rotation.instructions,
  });
  console.log(`${approver.name} checked the record and the instructions`);
}

// 4. Rotate.
console.log(
  `rotated: ${await send(rpc, wallet, rotation.instructions, { large: true })}`,
);

// 5. The members recover the new keys; the one that left does not.
await assertMembersRecover({
  members: [alice, bob, joining],
  removed: [leaving],
  expected: record,
  recover: (member) => recoverVaultKeys({ client, settings, member }),
});
console.log(
  `record:   ${rotation.upload.address} (key record ${record.epoch})`,
);
console.log("signers:");
for (const signer of (await fetchSettings(client, settings)).signers) {
  console.log(`  ${signer.key} (permissions ${signer.permissions})`);
}
