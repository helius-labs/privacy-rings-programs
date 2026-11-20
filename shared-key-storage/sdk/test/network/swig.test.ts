/**
 * Create, Register, Spend and Rotate a private Swig wallet on devnet or
 * mainnet using the deployed programs. Alice is the view key authority; the
 * other members can only spend. The main test is one test because each step
 * builds on the last.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { TransactionSigner } from "@solana/kit";
import { SOL_MINT } from "@heliuslabs/spr";
import type { SprClient } from "@heliuslabs/spr/client";
import { ShieldedKeypair, initializePoseidon } from "@heliuslabs/spr/keypair";
import { LocalShieldedKeys } from "@heliuslabs/spr/transaction";

import { encodeKeyRecord, recoverSharedSecrets } from "../../src/keyRecord.js";
import {
  prepareKeyRecordUpload,
  registerVaultKeysInstruction,
} from "../../src/registry.js";
import { publishRecordInstructions } from "../../src/record/storage.js";
import {
  addAuthorityInstruction,
  signV2Instruction,
} from "../../src/swig/program.js";
import {
  VIEW_KEY_AUTHORITY_ROLE,
  createSwigAccount,
  fetchSwig,
  memberActions,
  recoverSwigVaultKeys,
  registerSwigVaultInstruction,
  rotateSwigAccount,
  swigSpendInstruction,
  type CreatedSwig,
  type SolBudget,
} from "../../src/swig/flows.js";
import { vaultKeys, type Member } from "../../src/vault.js";
import {
  depositToVault,
  publishedRegistry,
  registeredMembers,
  uploadRecord,
  vaultRegistry,
} from "./flows.js";
import { networkSetup, send, syncedSolBalance, transferSol } from "./send.js";

/** About a day of slots. */
const WINDOW = 216_000n;
const AUTHORITY_BUDGET: SolBudget = { lamports: 100_000_000n, window: WINDOW };
const MEMBER_BUDGET: SolBudget = { lamports: 10_000_000n, window: WINDOW };
/** The rent-exempt minimum of the wallet address, which limited roles keep. */
const WALLET_RENT = 890_880n;
/** Swig `PermissionDeniedMissingPermission` and `PermissionDeniedToManageAuthority`. */
const MISSING_PERMISSION = /custom program error: 0xbbe|Custom\(3006\)|#3006/i;
const CANNOT_MANAGE_AUTHORITY =
  /custom program error: 0xbc2|Custom\(3010\)|#3010/i;

/** The error text a failed send carries, including the simulation's cause. */
function failure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return `${String(error)} ${String(cause)} ${JSON.stringify(cause ?? null, (_, value) => (typeof value === "bigint" ? String(value) : value))}`;
}

/**
 * Alice creates a Swig as view key authority with `others` as members and
 * funds its vault. Cleanup sweeps the vault back to the payer.
 */
async function createSwig(
  client: SprClient,
  payer: TransactionSigner,
  alice: Member,
  others: readonly Member[],
  t: TestContext,
): Promise<CreatedSwig> {
  const created = await createSwigAccount({
    payer,
    authority: alice.signer,
    authorityViewingKey: alice.keypair.viewingPublicKey(),
    members: others.map((member) => ({
      key: member.signer.address,
      viewingPublicKey: member.keypair.viewingPublicKey(),
    })),
    authorityBudget: AUTHORITY_BUDGET,
    memberBudget: MEMBER_BUDGET,
  });
  // The vault pays the registry rent and the SPP fees inside SignV2.
  t.after(async () => {
    const balance = await client.getBalance(created.vault);
    if (balance <= WALLET_RENT) return;
    await send(client, payer, [
      await signV2Instruction({
        swig: created.swig,
        roleId: VIEW_KEY_AUTHORITY_ROLE,
        authority: alice.signer,
        inner: [
          transferSol(created.vault, payer.address, balance - WALLET_RENT),
        ],
      }),
    ]);
  });
  await send(client, payer, [
    ...created.instructions,
    transferSol(payer, created.vault, 20_000_000n),
  ]);
  return created;
}

async function roleAuthorities(client: SprClient, created: CreatedSwig) {
  return (await fetchSwig(client, created.swig)).roles.map((role) => [
    role.id,
    role.authority,
  ]);
}

test(
  "create, register, spend and rotate a private Swig wallet",
  { timeout: 600_000 },
  async (t) => {
    await initializePoseidon();
    const { client, payer } = await networkSetup();
    const members = await registeredMembers(client, payer, 3, t);
    const [alice, bob, carol] = members;
    assert(alice && bob && carol);
    const recipient = ShieldedKeypair.generate();

    // Create: Alice is the view key authority, Bob a member.
    const created = await createSwig(client, payer, alice, [bob], t);
    assert.deepEqual(await roleAuthorities(client, created), [
      [0, alice.signer.address],
      [1, bob.signer.address],
    ]);

    // Upload and Register: Alice publishes record 0 for Alice and Bob.
    const firstUpload = await prepareKeyRecordUpload({
      owner: created.vault,
      payer,
      record: created.record,
    });
    await uploadRecord(client, payer, created.vault, firstUpload, t);
    await send(client, payer, [
      await registerSwigVaultInstruction({
        client,
        swig: created.swig,
        authority: alice.signer,
        record: created.record,
        upload: firstUpload.address,
      }),
    ]);
    assert.deepEqual(
      await vaultRegistry(client, created.vault),
      publishedRegistry(created.record, firstUpload),
    );

    // Spend: Bob alone pays 3,000,000 lamports from the vault.
    const bobKeys = await recoverSwigVaultKeys({
      client,
      swig: created.swig,
      member: bob,
    });
    assert.deepEqual(bobKeys.record, created.record);
    const vault = vaultKeys(
      client,
      created.vault,
      bobKeys.secrets,
      bobKeys.viewingKeys,
    );
    await depositToVault(client, payer, vault.address, 10_000_000n);
    const funded = await syncedSolBalance(
      client,
      vault.address,
      vault.shielded,
      10_000_000n,
    );
    await send(client, payer, [
      await swigSpendInstruction({
        client,
        swig: created.swig,
        spender: bob.signer,
        secrets: bobKeys.secrets,
        viewingKeys: bobKeys.viewingKeys,
        inputs: funded.balance(SOL_MINT).utxos,
        payments: [
          {
            recipient: recipient.shieldedAddress(),
            asset: SOL_MINT,
            amount: 3_000_000n,
          },
        ],
      }),
    ]);
    await syncedSolBalance(client, vault.address, vault.shielded, 7_000_000n);

    // Rotate: Alice replaces Bob with Carol. The rotation closes record 0
    // and its rent goes to the vault.
    const rotation = await rotateSwigAccount({
      client,
      swig: created.swig,
      authority: alice,
      payer,
      keep: [],
      add: [
        {
          key: carol.signer.address,
          viewingPublicKey: carol.keypair.viewingPublicKey(),
        },
      ],
      memberBudget: MEMBER_BUDGET,
    });
    assert.equal(rotation.record.epoch, 1n);
    await uploadRecord(client, payer, created.vault, rotation.upload, t);
    const firstRent = await client.getBalance(firstUpload.address);
    const vaultBefore = await client.getBalance(created.vault);
    assert(firstRent > 0n);
    await send(client, payer, rotation.instructions);
    assert.equal(
      await client.getBalance(created.vault),
      vaultBefore + firstRent,
    );
    assert.deepEqual(await roleAuthorities(client, created), [
      [0, alice.signer.address],
      [2, carol.signer.address],
    ]);
    assert.deepEqual(
      await vaultRegistry(client, created.vault),
      publishedRegistry(rotation.record, rotation.upload),
    );
    assert.throws(
      () =>
        recoverSharedSecrets(rotation.record, bob.signer.address, bob.keypair),
      /no entry/,
    );

    // Carol opens the UTXO that predates her membership and spends from it.
    const carolKeys = await recoverSwigVaultKeys({
      client,
      swig: created.swig,
      member: carol,
    });
    assert.equal(carolKeys.viewingKeys.length, 2);
    const carolVault = vaultKeys(
      client,
      created.vault,
      carolKeys.secrets,
      carolKeys.viewingKeys,
    );
    const beforeSpend = await syncedSolBalance(
      client,
      carolVault.address,
      carolVault.shielded,
      7_000_000n,
    );
    await send(client, payer, [
      await swigSpendInstruction({
        client,
        swig: created.swig,
        spender: carol.signer,
        secrets: carolKeys.secrets,
        viewingKeys: carolKeys.viewingKeys,
        inputs: beforeSpend.balance(SOL_MINT).utxos,
        payments: [
          {
            recipient: recipient.shieldedAddress(),
            asset: SOL_MINT,
            amount: 2_000_000n,
          },
        ],
      }),
    ]);
    await syncedSolBalance(
      client,
      carolVault.address,
      carolVault.shielded,
      5_000_000n,
    );
    await syncedSolBalance(
      client,
      recipient.shieldedAddress(),
      LocalShieldedKeys.fromKeypair(recipient),
      5_000_000n,
    );
  },
);

test(
  "members cannot publish key records or add roles, and rotate needs a registered vault",
  { timeout: 300_000 },
  async (t) => {
    await initializePoseidon();
    const { client, payer } = await networkSetup();
    const members = await registeredMembers(client, payer, 3, t);
    const [alice, bob, carol] = members;
    assert(alice && bob && carol);
    const created = await createSwig(client, payer, alice, [bob], t);
    const rotate = {
      client,
      swig: created.swig,
      authority: alice,
      payer,
      keep: [bob.signer.address],
      add: [],
      memberBudget: MEMBER_BUDGET,
    };

    // No key record is on chain before Register.
    await assert.rejects(rotateSwigAccount(rotate), /not registered/);

    const firstUpload = await prepareKeyRecordUpload({
      owner: created.vault,
      payer,
      record: created.record,
    });
    await uploadRecord(client, payer, created.vault, firstUpload, t);

    // Bob's role has no registry or Record permission, so Swig refuses his
    // SignV2 of the same Register, and the SDK refuses to build it.
    await assert.rejects(
      send(client, payer, [
        await signV2Instruction({
          swig: created.swig,
          roleId: 1,
          authority: bob.signer,
          inner: [
            await registerVaultKeysInstruction(created.vault, created.record),
            ...(await publishRecordInstructions({
              owner: created.vault,
              upload: firstUpload.address,
              predecessor: undefined,
              bytes: encodeKeyRecord(created.record),
            })),
          ],
        }),
      ]),
      (error) => MISSING_PERMISSION.test(failure(error)),
    );
    await assert.rejects(
      registerSwigVaultInstruction({
        client,
        swig: created.swig,
        authority: bob.signer,
        record: created.record,
        upload: firstUpload.address,
      }),
      /not the Swig's view key authority/,
    );

    // Bob cannot add a role either.
    await assert.rejects(
      send(client, payer, [
        addAuthorityInstruction({
          swig: created.swig,
          payer,
          authority: bob.signer,
          actingRoleId: 1,
          newAuthority: carol.signer.address,
          actions: memberActions(MEMBER_BUDGET),
        }),
      ]),
      (error) => CANNOT_MANAGE_AUTHORITY.test(failure(error)),
    );

    await send(client, payer, [
      await registerSwigVaultInstruction({
        client,
        swig: created.swig,
        authority: alice.signer,
        record: created.record,
        upload: firstUpload.address,
      }),
    ]);

    // Adding a current member is refused; it belongs in `keep`.
    await assert.rejects(
      rotateSwigAccount({
        ...rotate,
        keep: [],
        add: [
          {
            key: bob.signer.address,
            viewingPublicKey: bob.keypair.viewingPublicKey(),
          },
        ],
      }),
      /already has a Swig role/,
    );

    // A key-only rotate keeps both roles and replaces the record.
    const rotation = await rotateSwigAccount(rotate);
    assert.equal(rotation.instructions.length, 1);
    await uploadRecord(client, payer, created.vault, rotation.upload, t);
    await send(client, payer, rotation.instructions);
    assert.deepEqual(
      await vaultRegistry(client, created.vault),
      publishedRegistry(rotation.record, rotation.upload),
    );
  },
);
