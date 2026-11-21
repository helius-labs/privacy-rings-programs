/**
 * Removes the key record of a private Swig wallet.
 *
 * 1. Assert that every member still recovers the shared keys.
 * 2. One transaction: Alice's `SignV2`, as the view key authority, has the
 *    vault close its current record and its pointer with the Record
 *    program's `CloseAccount`. The rent of both goes to the vault. A member
 *    role has no Record permission and cannot do this.
 * 3. Assert that the vault has no published record and that recovery fails.
 *
 * The vault stays in the user registry with its last viewing key, so anyone
 * who kept the keys can still read its balance. A member that did not keep
 * them cannot recover them any more.
 *
 * Run: pnpm swig-close <swig>
 */
import assert from "node:assert/strict";

import {
  fetchPublishedKeyRecord,
  type Member,
  removeRecordInstructions,
  storagePointerAddress,
} from "@heliuslabs/shared-key-storage";
import {
  VIEW_KEY_AUTHORITY_ROLE,
  fetchSwig,
  swigMembers,
  swigVaultAddress,
} from "../helpers/swig/account.js";
import { signV2Instruction } from "../helpers/swig/program.js";
import { recoverSwigVaultKeys } from "../helpers/swig/recover.js";
import {
  addressArgument,
  assertMembersRecover,
  balance,
  connect,
  membersAmong,
  send,
} from "../common.js";

const swig = addressArgument("swig-close", "swig");

const session = await connect();
const { client, rpc, wallet, alice } = session;
const vault = await swigVaultAddress(swig);
const current = await fetchPublishedKeyRecord(client, vault);
if (current === undefined) throw new Error(`${swig} has no key record`);
console.log(
  `record:   ${current.address} (key record ${current.record.epoch})`,
);
console.log(`pointer:  ${await storagePointerAddress(vault)}`);

// 1. Every member recovers the shared keys.
const { members } = membersAmong(
  session,
  swigMembers(await fetchSwig(client, swig)),
);
const recover = (member: Member) =>
  recoverSwigVaultKeys({ client, swig, member });
await assertMembersRecover({ members, expected: current.record, recover });

// 2. Close, by the view key authority alone.
const before = await balance(rpc, vault);
const close = await signV2Instruction({
  swig,
  roleId: VIEW_KEY_AUTHORITY_ROLE,
  authority: alice.signer,
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
