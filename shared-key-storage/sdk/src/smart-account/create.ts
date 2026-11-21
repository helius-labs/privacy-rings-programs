/** Create (design.md, steps 3 and 4) for a Squads smart account. */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { ViewingKey } from "@heliuslabs/spr/keypair";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  buildKeyRecord,
  generateNullifierKey,
  type KeyRecord,
  type SharedSecrets,
} from "../keyRecord.js";
import {
  createSmartAccountInstruction,
  decodeProgramConfig,
  programConfigAddress,
  settingsAddress,
  vaultAddress,
} from "./program.js";
import { accountData, destroySecrets } from "../vault.js";
import { sortedSigners, type NewSigner } from "./account.js";

export interface CreatedAccount {
  readonly settings: Address;
  readonly vault: Address;
  /** Record 0; Register writes it on chain. */
  readonly record: KeyRecord;
  /** The `createSmartAccount` instruction; the creator signs it. */
  readonly instruction: Instruction;
}

/**
 * Create steps 3 and 4: generates the shared secrets and key record 0, and
 * returns the `createSmartAccount` instruction. The creator sends the
 * instruction and hands `record` to the other signers for Register.
 *
 * The Settings address comes from the Squads account counter, so another
 * account created in between makes the instruction fail; build again then.
 */
export async function createSmartAccount(
  input: Readonly<{
    client: SprClient;
    creator: TransactionSigner;
    signers: readonly NewSigner[];
    threshold: number;
  }>,
): Promise<CreatedAccount> {
  const configData = await accountData(
    input.client,
    await programConfigAddress(),
  );
  if (configData === undefined)
    throw new Error("the Squads ProgramConfig account is missing");
  const config = decodeProgramConfig(configData);
  const settings = await settingsAddress(config.smartAccountIndex + 1n);
  const vault = await vaultAddress(settings);

  const secrets: SharedSecrets = {
    viewingKey: ViewingKey.generate(),
    nullifierKey: generateNullifierKey(),
  };
  try {
    const record = buildKeyRecord({
      settings,
      epoch: 0n,
      secrets,
      previousViewingKeys: [],
      recipients: input.signers,
    });
    const instruction = await createSmartAccountInstruction({
      creator: input.creator,
      treasury: config.treasury,
      settings,
      signers: sortedSigners(input.signers),
      threshold: input.threshold,
    });
    return { settings, vault, record, instruction };
  } finally {
    destroySecrets(secrets);
  }
}
