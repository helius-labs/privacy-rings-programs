/**
 * Creates a private Squads smart account for three members, Alice, Bob and
 * Carol, with threshold 2, and publishes its first key record. The record
 * holds one shared viewing key, encrypted to each member.
 *
 * 1. Register each member's own keys in the user registry, where a later
 *    rotation reads them.
 * 2. Create the smart account and key record 0, and fund the vault, which
 *    pays the rent of its registry record and storage pointer.
 * 3. Upload the record into a Record account and freeze it under the vault.
 * 4. Register: Alice and Bob each check the upload, their own entry and the
 *    instruction, then co-sign `executeTransactionSyncV2`. The vault
 *    registers the shared keys in the user registry and publishes the record.
 * 5. Assert that every member recovers the shared keys from the record.
 *
 * Run: pnpm smart-account-create
 */
import { storagePointerAddress } from "@heliuslabs/shared-key-storage";
import { createSmartAccount } from "../helpers/smart-account/create.js";
import { Permission } from "../helpers/smart-account/program.js";
import { recoverVaultKeys } from "../helpers/smart-account/recover.js";
import {
  checkRegistration,
  registerVaultInstruction,
} from "../helpers/smart-account/register.js";
import {
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
const created = await createSmartAccount({
  client,
  creator: wallet,
  threshold: 2,
  signers: members.map((member) => ({
    ...recipient(member),
    permissions: Permission.All,
  })),
});
const { settings, vault, record } = created;
console.log(
  `created smart account ${settings}: ${await send(rpc, wallet, [
    created.instruction,
    transferSol(wallet, vault, VAULT_SOL),
  ])}`,
);

// 3. Upload.
const upload = await uploadKeyRecord(session, vault, record);

// 4. Register, approved by Alice and Bob.
const approvers = [alice, bob];
const register = await registerVaultInstruction({
  client,
  settings,
  approvers: approvers.map((approver) => approver.signer),
  record,
  upload,
});
for (const approver of approvers) {
  await checkRegistration({
    client,
    settings,
    record,
    upload,
    member: approver,
    approvers: approvers.map((each) => each.signer.address),
    proposed: [register],
  });
  console.log(`${approver.name} checked the record and the instruction`);
}
console.log(
  `registered: ${await send(rpc, wallet, [register], { large: true })}`,
);

// 5. Every member recovers the shared keys.
await assertMembersRecover({
  members,
  expected: record,
  recover: (member) => recoverVaultKeys({ client, settings, member }),
});

console.log(`settings: ${settings}`);
console.log(`vault:    ${vault}`);
console.log(`pointer:  ${await storagePointerAddress(vault)}`);
console.log(`record:   ${upload}`);
console.log(`next:     pnpm smart-account-rotate ${settings}`);
