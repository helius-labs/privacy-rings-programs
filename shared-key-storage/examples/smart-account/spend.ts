/**
 * Spends from a private Squads smart account. `setupPrivateSmartAccount`
 * creates the account with a fresh member as its only signer, registers its
 * vault and deposits 0.01 SOL into the vault's shielded balance. Then:
 *
 * 1. Recover: the member opens its entry of the current key record and gets
 *    the vault's shared viewing key, nullifier secret and old viewing keys.
 * 2. Sync: the member finds and decrypts the vault's UTXOs with those keys.
 * 3. Spend: the member builds and proves an SPP `transact` that pays a
 *    shielded recipient; Squads checks the member's approval in
 *    `executeTransactionSyncV2` and signs it as the vault.
 *
 * Run: pnpm smart-account-spend
 */
import { SOL_MINT } from "@heliuslabs/spr";
import { ShieldedKeypair } from "@heliuslabs/spr/keypair";
import { LocalShieldedKeys } from "@heliuslabs/spr/transaction";
import {
  recoverVaultKeys,
  spendInstruction,
  vaultKeys,
} from "@heliuslabs/shared-key-storage";

import {
  DEPOSIT,
  send,
  setupPrivateSmartAccount,
  syncedBalance,
} from "../common.js";

const { client, rpc, wallet, member, settings, vault } =
  await setupPrivateSmartAccount();
const recipient = ShieldedKeypair.generate();
const amount = 3_000_000n;

// 1. Recover.
const recovered = await recoverVaultKeys({ client, settings, member });
const keys = vaultKeys(client, vault, recovered.secrets, recovered.viewingKeys);

// 2. Sync.
const funded = await syncedBalance(
  client,
  keys.address,
  keys.shielded,
  DEPOSIT,
);
console.log(`vault balance: ${DEPOSIT} lamports`);

// 3. Spend.
const spend = await spendInstruction({
  client,
  settings,
  approvers: [member.signer],
  secrets: recovered.secrets,
  viewingKeys: recovered.viewingKeys,
  inputs: funded.balance(SOL_MINT).utxos,
  payments: [
    { recipient: recipient.shieldedAddress(), asset: SOL_MINT, amount },
  ],
});
console.log(`spend: ${await send(rpc, wallet, [spend], { large: true })}`);

await syncedBalance(
  client,
  recipient.shieldedAddress(),
  LocalShieldedKeys.fromKeypair(recipient),
  amount,
);
await syncedBalance(client, keys.address, keys.shielded, DEPOSIT - amount);
console.log(`recipient received ${amount}; vault keeps ${DEPOSIT - amount}`);
