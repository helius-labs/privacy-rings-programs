/**
 * Spends from a private Swig wallet with the shared keys. Bob, whose member
 * role may only use the shielded pool, spends on his own.
 *
 * 1. Recover: assert that every member recovers the shared keys from the
 *    current key record. Bob keeps his copy to spend with.
 * 2. Deposit 0.01 SOL into the vault's shielded address and sync the vault's
 *    UTXOs with the recovered viewing keys.
 * 3. Spend: Bob builds and proves an SPP `transact` that pays a shielded
 *    recipient. Swig checks Bob's role in `SignV2` and signs the `transact`
 *    as the vault.
 *
 * Run: pnpm swig-spend <swig>
 */
import { SOL_MINT } from "@heliuslabs/spr";
import { ShieldedKeypair } from "@heliuslabs/spr/keypair";
import { LocalShieldedKeys } from "@heliuslabs/spr/transaction";
import { vaultKeys } from "../helpers/spend.js";
import {
  fetchSwig,
  swigMembers,
  swigVaultAddress,
} from "../helpers/swig/account.js";
import { recoverSwigVaultKeys } from "../helpers/swig/recover.js";
import { swigSpendInstruction } from "../helpers/swig/spend.js";
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

const swig = addressArgument("swig-spend", "swig");

const session = await connect({ prover: true });
const { client, rpc, wallet, bob } = session;
const vault = await swigVaultAddress(swig);
const recipient = ShieldedKeypair.generate();
const amount = 3_000_000n;

// 1. Recover.
const recovered = await recoverSwigVaultKeys({ client, swig, member: bob });
const { members } = membersAmong(
  session,
  swigMembers(await fetchSwig(client, swig)),
);
await assertMembersRecover({
  members,
  expected: recovered.record,
  recover: (member) => recoverSwigVaultKeys({ client, swig, member }),
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

// 3. Spend, by Bob alone.
const spend = await swigSpendInstruction({
  client,
  swig,
  spender: bob.signer,
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
