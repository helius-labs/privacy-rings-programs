/**
 * Creates a private Swig wallet for three members and publishes its first
 * key record. Alice holds the root role, the view key authority, which
 * manages the key records and the members. Bob and Carol hold member roles,
 * which may only spend through the shielded pool. The record holds one shared
 * viewing key, encrypted to each of the three.
 *
 * 1. Register each member's own keys in the user registry, where a later
 *    rotation reads them.
 * 2. Create the Swig with its three roles and key record 0, and fund the
 *    vault, the Swig's wallet address, which pays the rent of its registry
 *    record and storage pointer.
 * 3. Upload the record into a Record account and freeze it under the vault.
 *    Bob and Carol check the upload and their own entries.
 * 4. Register: Alice's `SignV2` has the vault register the shared keys in the
 *    user registry and publish the record.
 * 5. Assert that every member recovers the shared keys from the record.
 *
 * Run: pnpm swig-create
 */
import {
  checkEntryOpens,
  checkProposedKeyRecord,
  storagePointerAddress,
} from "@heliuslabs/shared-key-storage";
import { createSwigAccount } from "../helpers/swig/create.js";
import { recoverSwigVaultKeys } from "../helpers/swig/recover.js";
import { registerSwigVaultInstruction } from "../helpers/swig/register.js";
import {
  SWIG_BUDGET,
  VAULT_SOL,
  assertMembersRecover,
  connect,
  ensureRegistered,
  recipient,
  send,
  transferSol,
  uploadKeyRecord,
} from "../common.js";

const session = await connect();
const { client, rpc, wallet, alice, bob, carol } = session;
const members = [alice, bob, carol];

// 1. Register the members.
for (const member of members) await ensureRegistered(session, member);

// 2. Create.
const created = await createSwigAccount({
  payer: wallet,
  authority: alice.signer,
  authorityViewingKey: alice.keypair.viewingPublicKey(),
  members: [recipient(bob), recipient(carol)],
  authorityBudget: SWIG_BUDGET,
  memberBudget: SWIG_BUDGET,
});
const { swig, vault, record } = created;
console.log(
  `created Swig ${swig}: ${await send(
    rpc,
    wallet,
    [...created.instructions, transferSol(wallet, vault, VAULT_SOL)],
    { large: true },
  )}`,
);

// 3. Upload; the members check it.
const upload = await uploadKeyRecord(session, vault, record);
for (const member of [bob, carol]) {
  await checkProposedKeyRecord({
    client,
    accountId: swig,
    vault,
    record,
    upload,
  });
  checkEntryOpens(record, member);
  console.log(`${member.name} checked the record and its own entry`);
}

// 4. Register, by the view key authority alone.
const register = await registerSwigVaultInstruction({
  client,
  swig,
  authority: alice.signer,
  record,
  upload,
});
console.log(
  `registered: ${await send(rpc, wallet, [register], { large: true })}`,
);

// 5. Every member recovers the shared keys.
await assertMembersRecover({
  members,
  expected: record,
  recover: (member) => recoverSwigVaultKeys({ client, swig, member }),
});

console.log(`swig:     ${swig}`);
console.log(`vault:    ${vault}`);
console.log(`pointer:  ${await storagePointerAddress(vault)}`);
console.log(`record:   ${upload}`);
console.log(`next:     pnpm swig-rotate ${swig}`);
