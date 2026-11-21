/**
 * Spend from the vault through the SPP, for any wallet. The only module that
 * uses the shielded pool client: UTXOs, the transfer and the proof.
 */
import type { Address, Instruction } from "@solana/kit";
import { ShieldedAddress, type ViewingKey } from "@heliuslabs/spr/keypair";
import { LocalKeys, type SprClient } from "@heliuslabs/spr/client";
import { transactInstruction } from "@heliuslabs/spr/interface";
import {
  AssetRegistry,
  ConfidentialTransfer,
  LocalShieldedKeys,
  ProofInputUtxo,
  encryptConfidentialTransfer,
  type Utxo,
} from "@heliuslabs/spr/transaction";

import { type SharedSecrets } from "@heliuslabs/shared-key-storage";

export interface Payment {
  readonly recipient: ShieldedAddress;
  readonly asset: Address;
  readonly amount: bigint;
}

/** The key holders for syncing and proving as the vault. */
export function vaultKeys(
  client: SprClient,
  vault: Address,
  secrets: SharedSecrets,
  viewingKeys: readonly ViewingKey[],
): Readonly<{
  address: ShieldedAddress;
  shielded: LocalShieldedKeys;
  proving: LocalKeys;
}> {
  const address = ShieldedAddress.forPda({
    pda: vault,
    nullifierPublicKey: secrets.nullifierKey.publicKey(),
    viewingPublicKey: secrets.viewingKey.publicKey(),
  });
  const keys = { address, viewingKeys, nullifierKey: secrets.nullifierKey };
  const shielded = LocalShieldedKeys.fromKeys(keys);
  try {
    return {
      address,
      shielded,
      proving: LocalKeys.fromKeys(keys, client.proofService),
    };
  } catch (error) {
    shielded.destroy();
    throw error;
  }
}

/**
 * Build and prove (design.md, "Using the recovered keys"): a confidential
 * transfer from the vault's UTXOs, proved with the shared nullifier secret,
 * as the SPP `transact` the wallet runs signed by the vault. The vault is the
 * owner signer and the SPP payer, so it needs SOL for the fees.
 */
export async function vaultTransactInstruction(
  input: Readonly<{
    client: SprClient;
    vault: Address;
    secrets: SharedSecrets;
    viewingKeys: readonly ViewingKey[];
    inputs: readonly Utxo[];
    payments: readonly Payment[];
  }>,
): Promise<Instruction> {
  const { vault } = input;
  const assets = new AssetRegistry();
  const keys = vaultKeys(input.client, vault, input.secrets, input.viewingKeys);
  try {
    const proofInputs = input.inputs.map((utxo) =>
      ProofInputUtxo.fromNullifierKey(utxo, input.secrets.nullifierKey),
    );
    const transfer = new ConfidentialTransfer(keys.address, proofInputs, vault);
    for (const payment of input.payments) {
      transfer.send(payment.recipient, payment.asset, payment.amount);
    }
    const prepared = transfer.prepare();
    const [txKey] = await keys.shielded.transactionKeys([
      {
        viewingPublicKey: keys.address.viewingPublicKey,
        firstNullifier: prepared.firstNullifier,
      },
    ]);
    if (txKey === undefined)
      throw new Error("no transaction key for the transfer");
    let encrypted: ReturnType<typeof encryptConfidentialTransfer>;
    try {
      encrypted = encryptConfidentialTransfer(txKey, {
        outputs: prepared.outputs,
        assets,
      });
    } finally {
      txKey.destroy();
    }
    const sppProofInputs = prepared.finalize({
      txViewingPublicKey: encrypted.txViewingPublicKey,
      salt: encrypted.salt,
      payload: encrypted.payload,
    });
    const data = await input.client.proveTransact(sppProofInputs, keys.proving);
    return transactInstruction({
      payer: vault,
      ownerSigners: [vault],
      inputTree: input.client.tree,
      outputTree: input.client.tree,
      data,
    });
  } finally {
    keys.shielded.destroy();
    keys.proving.destroy();
  }
}
