/**
 * What the Swig actions share: the role permissions, reading the Swig's
 * roles and the current key record. The vault is the Swig wallet address;
 * Swig signs for it in `SignV2`. Swig has no threshold: each role acts alone,
 * so the roles split the work by permission.
 *
 * - The view key authority is the root role (id 0). It alone can register
 *   the vault, publish key records and add or remove members. It always has
 *   an entry in the key record, since a rotation decrypts the current record.
 * - Every other role is a member. It can spend through the shielded pool,
 *   within a SOL limit for fees, but cannot touch key records, the user
 *   registry or membership.
 *
 * Swig checks a role's program permissions on every inner instruction the
 * wallet address signs, so the split is enforced on chain.
 */
import type { Address } from "@solana/kit";
import {
  SHIELDED_POOL_PROGRAM_ID,
  USER_REGISTRY_PROGRAM_ID,
} from "@heliuslabs/spr/interface";
import type { SprClient } from "@heliuslabs/spr/client";

import {
  fetchCurrentKeyRecord,
  type KeyRecordPublication,
  RECORD_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from "@heliuslabs/shared-key-storage";
import {
  decodeSwig,
  swigRoleOf,
  swigWalletAddress,
  type SwigAccount,
  type SwigAction,
} from "./program.js";
import { accountData } from "../account.js";

/** The view key authority's role. */
export const VIEW_KEY_AUTHORITY_ROLE = 0;

/** A recurring SOL budget: `lamports` per `window` slots. */
export interface SolBudget {
  readonly lamports: bigint;
  readonly window: bigint;
}

/**
 * Root role: membership, key records (System for the pointer's rent, Record,
 * the user registry) and private spends, within `budget` for rent and fees.
 */
export function viewKeyAuthorityActions(budget: SolBudget): SwigAction[] {
  return [
    { kind: "manageAuthority" },
    { kind: "program", program: SYSTEM_PROGRAM_ADDRESS },
    { kind: "program", program: RECORD_PROGRAM_ADDRESS },
    { kind: "program", program: USER_REGISTRY_PROGRAM_ID },
    { kind: "program", program: SHIELDED_POOL_PROGRAM_ID },
    { kind: "solRecurringLimit", ...budget },
  ];
}

/** Member role: private spends only, within `budget` for fees. */
export function memberActions(budget: SolBudget): SwigAction[] {
  return [
    { kind: "program", program: SHIELDED_POOL_PROGRAM_ID },
    { kind: "solRecurringLimit", ...budget },
  ];
}

export async function fetchSwig(
  client: SprClient,
  swig: Address,
): Promise<SwigAccount> {
  const data = await accountData(client, swig);
  if (data === undefined) throw new Error(`Swig ${swig} does not exist`);
  return decodeSwig(data);
}

/** The Ed25519 authorities of every role: the key record's signers. */
export function swigMembers(swig: SwigAccount): Address[] {
  return swig.roles.map((role) => {
    if (role.authority === undefined) {
      throw new Error(`Swig role ${role.id} is not an Ed25519 authority`);
    }
    return role.authority;
  });
}

/** The vault: the Swig wallet address. */
export async function swigVaultAddress(swig: Address): Promise<Address> {
  return (await swigWalletAddress(swig)).address;
}

/** Throws unless `authority` holds the view key authority role. */
export function checkViewKeyAuthority(
  swig: SwigAccount,
  authority: Address,
): void {
  if (swigRoleOf(swig, authority)?.id !== VIEW_KEY_AUTHORITY_ROLE) {
    throw new Error(`${authority} is not the Swig's view key authority`);
  }
}

/** The role id of `signer`, which must be an authority of `swig`. */
export function roleId(swig: SwigAccount, signer: Address): number {
  const role = swigRoleOf(swig, signer);
  if (role === undefined) throw new Error(`${signer} has no Swig role`);
  return role.id;
}

/**
 * The current key record of a registered vault: it must name exactly the
 * Swig's authorities.
 */
export async function fetchCurrentSwigRecord(
  client: SprClient,
  swig: Address,
  decoded: SwigAccount,
): Promise<KeyRecordPublication> {
  return fetchCurrentKeyRecord(
    client,
    swig,
    await swigVaultAddress(swig),
    swigMembers(decoded),
  );
}
