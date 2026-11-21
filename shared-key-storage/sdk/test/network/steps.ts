/** Steps shared by the Squads and Swig network tests. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import {
  fetchEncodedAccount,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";
import { ShieldedKeypair } from "@heliuslabs/spr/keypair";
import { DepositAsset, depositInstruction } from "@heliuslabs/spr/interface";
import { getRegisterInstructionAsync } from "@heliuslabs/spr/instructions";

import type { KeyRecord } from "../../src/keyRecord.js";
import {
  fetchStoragePointer,
  type RecordUpload,
} from "../../src/record/storage.js";
import { decodeRecordAccount } from "../../src/record/program.js";
import {
  fetchVaultRegistry,
  type VaultRegistry,
} from "../../src/core/account.js";
import { memberFromKeypair, type Member } from "../../src/core/member.js";
import { vaultKeys } from "../../src/core/spend.js";
import { send, transferSol } from "./send.js";

/**
 * Partial uploads never change the published pointer; uploads the payer still
 * controls are cancelled and refunded afterwards.
 */
export async function uploadRecord(
  client: SprClient,
  payer: TransactionSigner,
  owner: Address,
  upload: RecordUpload,
  t: TestContext,
): Promise<void> {
  t.after(async () => {
    const account = await fetchEncodedAccount(
      client.solanaRpc,
      upload.address,
      { commitment: "confirmed" },
    );
    if (
      account.exists &&
      decodeRecordAccount(account.data).authority === payer.address
    ) {
      await send(client, payer, [upload.closeInstruction]);
    }
  });
  const previous = await fetchStoragePointer(client.solanaRpc, owner);
  for (const instructions of upload.transactions) {
    await send(client, payer, instructions);
    assert.deepEqual(
      await fetchStoragePointer(client.solanaRpc, owner),
      previous,
      "upload leaves the published pointer unchanged",
    );
  }
}

/**
 * Registers `count` fresh members. Each registers its own keys, because rotate
 * reads kept signers' viewing keys from the registry.
 */
export async function registeredMembers(
  client: SprClient,
  payer: TransactionSigner,
  count: number,
  t: TestContext,
): Promise<Member[]> {
  const members = Array.from({ length: count }, () =>
    memberFromKeypair(ShieldedKeypair.generate()),
  );
  t.after(async () => {
    for (const member of members) {
      const balance = await client.getBalance(member.signer.address);
      if (balance > 0n) {
        await send(client, payer, [
          transferSol(member.signer, payer.address, balance),
        ]);
      }
    }
  });
  for (const member of members) {
    await send(client, payer, [
      await getRegisterInstructionAsync({
        owner: member.signer,
        payer,
        nullifierPublicKey: member.keypair.nullifierPublicKey(),
        viewingPublicKey: member.keypair.viewingPublicKey().toBytes(),
      }),
    ]);
  }
  return members;
}

/** The registered viewing key and the current key record of `vault`. */
export async function vaultRegistry(
  client: SprClient,
  vault: Address,
): Promise<VaultRegistry> {
  const registry = await fetchVaultRegistry(client, vault);
  assert(registry !== undefined, "the vault is registered");
  return registry;
}

/** The registry state after `upload` of `record` became the vault's current record. */
export function publishedRegistry(
  record: KeyRecord,
  upload: RecordUpload,
): VaultRegistry {
  return {
    viewingPublicKey: record.sharedViewingPublicKey,
    current: { address: upload.address, record },
  };
}

export async function depositToVault(
  client: SprClient,
  depositor: TransactionSigner,
  vaultAddress: ReturnType<typeof vaultKeys>["address"],
  amount: bigint,
): Promise<void> {
  await send(client, depositor, [
    await depositInstruction({
      tree: client.tree,
      depositor,
      deposits: [
        {
          asset: DepositAsset.sol(),
          viewTag: vaultAddress.confidentialViewTag(),
          recipientOwnerHash: vaultAddress.ownerHash(),
          amount,
        },
      ],
    }),
  ]);
}
