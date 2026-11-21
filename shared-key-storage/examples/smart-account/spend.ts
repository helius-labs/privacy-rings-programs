/**
 * Spends from a private Squads smart account with the shared keys.
 *
 * 1. Recover: assert that every member recovers the shared keys from the
 *    current key record. Bob keeps his copy to spend with.
 * 2. Deposit 0.01 SOL into the vault's shielded address and sync the vault's
 *    UTXOs with the recovered viewing keys.
 * 3. Spend: Bob builds and proves an SPP `transact` that pays a shielded
 *    recipient. Alice and Bob co-sign `executeTransactionSyncV2`, and Squads
 *    signs the `transact` as the vault.
 *
 * Run: pnpm smart-account-spend <settings>
 */
import { SOL_MINT } from "@heliuslabs/spr";
import { ShieldedKeypair } from "@heliuslabs/spr/keypair";
import { LocalShieldedKeys } from "@heliuslabs/spr/transaction";
import { fetchSettings } from "../helpers/smart-account/account.js";
import { vaultAddress } from "../helpers/smart-account/program.js";
import { recoverVaultKeys } from "../helpers/smart-account/recover.js";
import { spendInstruction } from "../helpers/smart-account/spend.js";
import { vaultKeys } from "../helpers/spend.js";
import {
  addressArgument,
  DEPOSIT,
  assertMembersRecover,
  connect,
  depositToVault,
  membersAmong,
  send,
  shieldedWallet,
  syncedBalance,
} from "../common.js";

const settings = addressArgument("smart-account-spend", "settings");

const session = await connect({ prover: true });
const { client, rpc, wallet, alice, bob } = session;
const vault = await vaultAddress(settings);
const recipient = ShieldedKeypair.generate();
const amount = 3_000_000n;

// 1. Recover.
const recovered = await recoverVaultKeys({ client, settings, member: bob });
const { members } = membersAmong(
  session,
  (await fetchSettings(client, settings)).signers.map((signer) => signer.key),
);
await assertMembersRecover({
  members,
  expected: recovered.record,
  recover: (member) => recoverVaultKeys({ client, settings, member }),
});
const keys = vaultKeys(client, vault, recovered.secrets, recovered.viewingKeys);

// 2. Deposit and sync.
const before = (
  await shieldedWallet(client, keys.address, keys.shielded)
).balance(SOL_MINT).amount;
await depositToVault(session, keys.address);
const funded = await syncedBalance(
  client,
  keys.address,
  keys.shielded,
  before + DEPOSIT,
);
console.log(`vault balance: ${before + DEPOSIT} lamports`);

// 3. Spend, built by Bob and approved by Alice and Bob.
const spend = await spendInstruction({
  client,
  settings,
  approvers: [alice.signer, bob.signer],
  secrets: recovered.secrets,
  viewingKeys: recovered.viewingKeys,
  inputs: funded.balance(SOL_MINT).utxos,
  payments: [
    { recipient: recipient.shieldedAddress(), asset: SOL_MINT, amount },
  ],
});
console.log(`spend:    ${await send(rpc, wallet, [spend], { large: true })}`);

await syncedBalance(
  client,
  recipient.shieldedAddress(),
  LocalShieldedKeys.fromKeypair(recipient),
  amount,
);
const after = before + DEPOSIT - amount;
await syncedBalance(client, keys.address, keys.shielded, after);
console.log(`recipient received ${amount}; vault keeps ${after}`);
