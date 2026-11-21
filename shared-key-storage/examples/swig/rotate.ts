/**
 * Rotates a private Swig wallet: replaces its third member and its shared
 * viewing key in one transaction. Carol leaves and Dave joins, or the other
 * way round if Dave is the member.
 *
 * 1. Alice, the view key authority, recovers the current keys and builds the
 *    next key record: a new shared viewing key for Alice, Bob and the joining
 *    member, with every earlier viewing key. Alice's and Bob's viewing keys
 *    come from the user registry.
 * 2. Upload the record and freeze it under the vault. The current record
 *    stays published meanwhile. Bob and the joining member check the upload,
 *    the key history and their own entries.
 * 3. One transaction: Alice's `SignV2` has the vault set the new viewing key
 *    in the user registry, publish the new record and close the old one;
 *    `AddAuthorityV1` and `RemoveAuthorityV1` swap the member role.
 * 4. Assert that the three members recover the new keys, including the old
 *    viewing key, and that the member that left does not.
 *
 * Run: pnpm swig-rotate <swig>
 */
import {
  checkEntryOpens,
  checkProposedKeyRecord,
} from "@heliuslabs/shared-key-storage";
import {
  fetchSwig,
  swigMembers,
  swigVaultAddress,
} from "../helpers/swig/account.js";
import { recoverSwigVaultKeys } from "../helpers/swig/recover.js";
import { rotateSwigAccount } from "../helpers/swig/rotate.js";
import {
  addressArgument,
  SWIG_BUDGET,
  assertMembersRecover,
  connect,
  ensureRegistered,
  membersAmong,
  recipient,
  send,
  sendUpload,
} from "../common.js";

const swig = addressArgument("swig-rotate", "swig");

const session = await connect();
const { client, rpc, wallet, alice, bob, carol, dave } = session;
const { members } = membersAmong(
  session,
  swigMembers(await fetchSwig(client, swig)),
);
const [leaving, joining] = members.includes(carol)
  ? [carol, dave]
  : [dave, carol];
if (![alice, bob, leaving].every((member) => members.includes(member))) {
  throw new Error(`${swig} is not a Swig of swig-create`);
}
console.log(`${leaving.name} leaves, ${joining.name} joins`);
await ensureRegistered(session, joining);

// 1. Build the next key record.
const rotation = await rotateSwigAccount({
  client,
  swig,
  authority: alice,
  payer: wallet,
  keep: [bob.signer.address],
  add: [recipient(joining)],
  memberBudget: SWIG_BUDGET,
});
const { record } = rotation;

// 2. Upload; the members check it.
await sendUpload(session, rotation.upload);
const vault = await swigVaultAddress(swig);
for (const member of [bob, joining]) {
  await checkProposedKeyRecord({
    client,
    accountId: swig,
    vault,
    record,
    upload: rotation.upload.address,
  });
  checkEntryOpens(record, member);
  console.log(`${member.name} checked the record and its own entry`);
}

// 3. Rotate, by the view key authority alone.
console.log(
  `rotated: ${await send(rpc, wallet, rotation.instructions, { large: true })}`,
);

// 4. The members recover the new keys; the one that left does not.
await assertMembersRecover({
  members: [alice, bob, joining],
  removed: [leaving],
  expected: record,
  recover: (member) => recoverSwigVaultKeys({ client, swig, member }),
});
console.log(
  `record:   ${rotation.upload.address} (key record ${record.epoch})`,
);
console.log("roles:");
for (const role of (await fetchSwig(client, swig)).roles) {
  console.log(`  role ${role.id}: ${role.authority ?? "(not Ed25519)"}`);
}
