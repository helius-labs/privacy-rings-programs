/**
 * What the Squads smart-account actions share: the Settings account, the
 * current key record named by the vault's storage pointer, the approvers'
 * sync consensus and the record checks before an approver co-signs. The
 * vault (Squads smart account at index 0) owns the shielded UTXOs; Squads
 * signs for it in `executeTransactionSyncV2`.
 */
import type { Address, TransactionSigner } from "@solana/kit";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  checkEntryOpens,
  checkProposedKeyRecord as checkProposedVaultRecord,
  compareAddresses,
  fetchCurrentKeyRecord as fetchCurrentVaultRecord,
  type KeyRecipient,
  type KeyRecord,
  type KeyRecordPublication,
  type Member,
} from "@heliuslabs/shared-key-storage";
import {
  checkSyncConsensus,
  decodeSettings,
  vaultAddress,
  type Settings,
  type SmartAccountSigner,
} from "./program.js";
import { accountData } from "../account.js";

/** A signer to add: its Squads permissions and its viewing public key. */
export interface NewSigner extends SmartAccountSigner, KeyRecipient {}

export async function fetchSettings(
  client: SprClient,
  settings: Address,
): Promise<Settings> {
  const data = await accountData(client, settings);
  if (data === undefined)
    throw new Error(`Squads Settings ${settings} does not exist`);
  return decodeSettings(data);
}

/**
 * The current key record of a registered vault, read with the Squads
 * signers in one place so both come from the same reads.
 */
export async function fetchCurrentKeyRecord(
  client: SprClient,
  settings: Address,
  decoded: Settings,
): Promise<KeyRecordPublication> {
  return fetchCurrentVaultRecord(
    client,
    settings,
    await vaultAddress(settings),
    decoded.signers.map((signer) => signer.key),
  );
}

export async function checkProposedKeyRecord(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    record: KeyRecord;
    upload: Address;
  }>,
): Promise<KeyRecordPublication | undefined> {
  return checkProposedVaultRecord({
    ...input,
    accountId: input.settings,
    vault: await vaultAddress(input.settings),
  });
}

/**
 * For an approver that stays or becomes a signer, before it co-signs a
 * Register or Rotate: checks that the upload at `upload` is frozen under the
 * vault and holds exactly `record`, and that its own entry in the record
 * opens to keys matching the record, including every old viewing key. The
 * previous record comes from the vault's storage pointer, the same record the
 * publication closes, never from the rotator. Before Register there is none,
 * so `record` must be epoch 0. Throws on a mismatched upload, a bad
 * ciphertext, a missing key or a broken history.
 *
 * This checks the record, not the transaction that publishes it; use
 * `checkRegistration` or `checkRotation` to check both.
 */
export async function checkOwnEntry(
  input: Readonly<{
    client: SprClient;
    settings: Address;
    record: KeyRecord;
    upload: Address;
    member: Member;
  }>,
): Promise<void> {
  await checkProposedKeyRecord(input);
  checkEntryOpens(input.record, input.member);
}

/** `signers` as Squads stores them: key and permissions, sorted by key. */
export function sortedSigners(
  signers: readonly SmartAccountSigner[],
): SmartAccountSigner[] {
  return signers
    .map(({ key, permissions }) => ({ key, permissions }))
    .sort((a, b) => compareAddresses(a.key, b.key));
}

export async function checkApprovers(
  client: SprClient,
  settings: Address,
  approvers: readonly TransactionSigner[],
): Promise<Settings> {
  const decoded = await fetchSettings(client, settings);
  checkSyncConsensus(
    decoded,
    approvers.map((approver) => approver.address),
  );
  return decoded;
}
