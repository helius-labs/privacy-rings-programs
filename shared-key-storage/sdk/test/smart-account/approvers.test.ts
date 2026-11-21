/**
 * What an approver checks before co-signing a Register or a Rotate: the
 * proposed instructions must be exactly the ones it builds itself.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, it } from "node:test";

import {
  AccountRole,
  createNoopSigner,
  generateKeyPairSigner,
  getAddressEncoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  ShieldedKeypair,
  ViewingKey,
  initializePoseidon,
} from "@heliuslabs/spr/keypair";

import { ByteWriter } from "../../src/bytes.js";
import {
  buildKeyRecord,
  encodeKeyRecord,
  generateNullifierKey,
  type KeyRecord,
} from "../../src/keyRecord.js";
import { updateKeysInstruction } from "../../src/registry.js";
import {
  checkRegistration,
  registerVaultInstruction,
} from "../../src/smart-account/register.js";
import {
  checkRotation,
  rotateSmartAccountInstructions,
} from "../../src/smart-account/rotate.js";
import {
  checkInstructionsMatch,
  memberFromKeypair,
  type Member,
} from "../../src/vault.js";
import {
  Permission,
  SMART_ACCOUNT_PROGRAM_ADDRESS,
  decodeSettings,
  executeTransactionSyncInstruction,
  vaultAddress,
  type SmartAccountSigner,
} from "../../src/smart-account/program.js";
import { SYSTEM_PROGRAM_ADDRESS } from "../../src/cpi.js";
import { publishRecordInstructions } from "../../src/record/storage.js";
import {
  accountClient,
  publish,
  upload,
  type FakeAccounts,
} from "../storageAccounts.js";

const addressEncoder = getAddressEncoder();

async function newAddress(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

function newMember(): Member {
  return memberFromKeypair(ShieldedKeypair.generate());
}

function signerWithAllPermissions(member: Member): SmartAccountSigner {
  return { key: member.signer.address, permissions: Permission.All };
}

/** An autonomous Squads Settings account with no time lock. */
function settingsAccountBytes(
  signers: readonly SmartAccountSigner[],
  threshold: number,
): Uint8Array {
  const writer = new ByteWriter()
    .bytes(
      createHash("sha256").update("account:Settings").digest().subarray(0, 8),
    )
    .u128(1n) // seed
    .bytes(addressEncoder.encode(SYSTEM_PROGRAM_ADDRESS)) // settings_authority
    .u16(threshold)
    .u32(0) // time_lock
    .u64(0n) // transaction_index
    .u64(0n) // stale_transaction_index
    .u8(0) // archival_authority: None
    .u64(0n) // archivable_after
    .u8(255) // bump
    .u32(signers.length);
  for (const signer of signers) {
    writer.bytes(addressEncoder.encode(signer.key)).u8(signer.permissions);
  }
  return writer.finish();
}

function keyRecordFor(
  settings: Address,
  members: readonly Member[],
  previousViewingKeys: readonly ViewingKey[],
  secrets = {
    viewingKey: ViewingKey.generate(),
    nullifierKey: generateNullifierKey(),
  },
) {
  const record = buildKeyRecord({
    settings,
    epoch: BigInt(previousViewingKeys.length),
    secrets,
    previousViewingKeys,
    recipients: members.map((member) => ({
      key: member.signer.address,
      viewingPublicKey: member.keypair.viewingPublicKey(),
    })),
  });
  return { record, secrets };
}

/**
 * A 2-of-2 account of Alice and Bob with record 0 published, and a proposed
 * rotation that keeps Alice, removes Bob and adds Carol.
 */
async function rotationScenario() {
  const [alice, bob, carol] = [newMember(), newMember(), newMember()];
  const settings = await newAddress();
  const vault = await vaultAddress(settings);
  const currentSigners = [alice, bob].map(signerWithAllPermissions);
  const accounts: FakeAccounts = new Map();
  accounts.set(settings, {
    owner: SMART_ACCOUNT_PROGRAM_ADDRESS,
    data: settingsAccountBytes(currentSigners, 2),
  });
  const first = keyRecordFor(settings, [alice, bob], []);
  const predecessor = await newAddress();
  await publish(accounts, {
    owner: vault,
    record: predecessor,
    bytes: encodeKeyRecord(first.record),
  });
  const anotherRecord = (): KeyRecord =>
    keyRecordFor(settings, [alice, carol], [first.secrets.viewingKey], {
      viewingKey: ViewingKey.generate(),
      nullifierKey: first.secrets.nullifierKey,
    }).record;
  const record = anotherRecord();
  const uploaded = await newAddress();
  upload(accounts, {
    owner: vault,
    record: uploaded,
    bytes: encodeKeyRecord(record),
  });
  const approvers = [alice.signer.address, bob.signer.address];
  const add = [signerWithAllPermissions(carol)];
  /** The rotator's instructions, optionally built from changed input. */
  const propose = (
    changed: Partial<Parameters<typeof rotateSmartAccountInstructions>[0]> = {},
  ) =>
    rotateSmartAccountInstructions({
      settings,
      current: decodeSettings(settingsAccountBytes(currentSigners, 2)),
      approvers: approvers.map((approver) => createNoopSigner(approver)),
      rentPayer: createNoopSigner(alice.signer.address),
      record,
      upload: uploaded,
      predecessor,
      next: [signerWithAllPermissions(alice), ...add],
      threshold: 2,
      ...changed,
    });
  const check = (
    proposed: readonly Instruction[],
    member: Member = alice,
    changed: Partial<Parameters<typeof checkRotation>[0]> = {},
  ) =>
    checkRotation({
      client: accountClient(accounts),
      settings,
      record,
      upload: uploaded,
      member,
      approvers,
      rentPayer: alice.signer.address,
      keep: [alice.signer.address],
      add,
      threshold: 2,
      proposed,
      ...changed,
    });
  return {
    alice,
    bob,
    carol,
    settings,
    vault,
    record,
    uploaded,
    predecessor,
    approvers,
    anotherRecord,
    propose,
    check,
  };
}

describe("approver checks", () => {
  before(async () => {
    await initializePoseidon();
  });

  it("accepts the Rotate instructions an approver would build itself", async () => {
    const scenario = await rotationScenario();
    const proposed = await scenario.propose();
    // The publication and the settings change.
    assert.equal(proposed.length, 2);
    await scenario.check(proposed, scenario.alice);
    // Bob is removed and has no entry; the instructions are still checked.
    await scenario.check(proposed, scenario.bob);
  });

  it("rejects Rotate instructions that differ from the approved rotation", async () => {
    const scenario = await rotationScenario();
    const { vault, record, uploaded, predecessor, settings } = scenario;
    const honest = await scenario.propose();
    const [publication, settingsChange] = honest;
    assert.ok(publication && settingsChange);

    // The same publication, but the closed record's rent goes elsewhere.
    const inner = [
      await updateKeysInstruction(vault, record.sharedViewingPublicKey),
      ...(await publishRecordInstructions({
        owner: vault,
        upload: uploaded,
        predecessor,
        bytes: encodeKeyRecord(record),
      })),
    ];
    const close = inner.at(-1);
    assert.ok(close?.accounts);
    const thief = await newAddress();
    const redirected = await executeTransactionSyncInstruction({
      settings,
      approvers: scenario.approvers.map((approver) =>
        createNoopSigner(approver),
      ),
      inner: [
        ...inner.slice(0, -1),
        {
          ...close,
          accounts: [
            ...close.accounts.slice(0, 2),
            { address: thief, role: AccountRole.WRITABLE },
          ],
        },
      ],
    });

    const tampered: [string, readonly Instruction[], RegExp][] = [
      [
        "another record's hash in the pointer",
        await scenario.propose({ record: scenario.anotherRecord() }),
        /instruction 0/,
      ],
      [
        "another record closed",
        await scenario.propose({ predecessor: await newAddress() }),
        /instruction 0/,
      ],
      [
        "the closed record's rent sent elsewhere",
        [redirected, settingsChange],
        /instruction 0/,
      ],
      [
        "another upload published",
        await scenario.propose({ upload: await newAddress() }),
        /instruction 0/,
      ],
      [
        "a lower threshold",
        await scenario.propose({ threshold: 1 }),
        /instruction 1/,
      ],
      [
        "other permissions for the added signer",
        await scenario.propose({
          next: [
            signerWithAllPermissions(scenario.alice),
            { key: scenario.carol.signer.address, permissions: 1 },
          ],
        }),
        /instruction 1/,
      ],
      ["the settings change left out", [publication], /expected 2/],
      ["an extra instruction", [...honest, publication], /expected 2/],
    ];
    for (const [name, proposed, error] of tampered) {
      await assert.rejects(scenario.check(proposed), error, name);
    }
  });

  it("rejects a rotation the approver did not agree to", async () => {
    const scenario = await rotationScenario();
    const proposed = await scenario.propose();
    const notTheRecordsSigners = /not the key record's signers/;
    // The approver expects Bob to stay; the rotation drops him.
    await assert.rejects(
      scenario.check(proposed, scenario.bob, {
        keep: [scenario.alice.signer.address, scenario.bob.signer.address],
      }),
      notTheRecordsSigners,
    );
    // The approver agreed to add nobody.
    await assert.rejects(
      scenario.check(proposed, scenario.alice, { add: [] }),
      notTheRecordsSigners,
    );
    // The approver agreed to add someone the record has no entry for.
    await assert.rejects(
      scenario.check(proposed, scenario.alice, {
        add: [
          signerWithAllPermissions(scenario.carol),
          signerWithAllPermissions(newMember()),
        ],
      }),
      notTheRecordsSigners,
    );
    // Only current signers can be kept, and only new ones added.
    await assert.rejects(
      scenario.check(proposed, scenario.alice, {
        keep: [scenario.carol.signer.address],
      }),
      /is not a current signer/,
    );
    await assert.rejects(
      scenario.check(proposed, scenario.alice, {
        add: [signerWithAllPermissions(scenario.alice)],
      }),
      /already a signer/,
    );
    // The approver agreed to another threshold.
    await assert.rejects(
      scenario.check(proposed, scenario.alice, { threshold: 1 }),
      /instruction 1/,
    );
    // One approver cannot meet the threshold of two.
    await assert.rejects(
      scenario.check(proposed, scenario.alice, {
        approvers: [scenario.alice.signer.address],
      }),
      /need 2 voting approvers/,
    );
  });

  it("checks the Register instruction the same way", async () => {
    const [alice, bob] = [newMember(), newMember()];
    const settings = await newAddress();
    const vault = await vaultAddress(settings);
    const accounts: FakeAccounts = new Map();
    accounts.set(settings, {
      owner: SMART_ACCOUNT_PROGRAM_ADDRESS,
      data: settingsAccountBytes([alice, bob].map(signerWithAllPermissions), 2),
    });
    const { record } = keyRecordFor(settings, [alice, bob], []);
    const uploaded = await newAddress();
    upload(accounts, {
      owner: vault,
      record: uploaded,
      bytes: encodeKeyRecord(record),
    });
    const client = accountClient(accounts);
    const approvers = [alice.signer.address, bob.signer.address];
    const register = (published: Address) =>
      registerVaultInstruction({
        client,
        settings,
        approvers: approvers.map((approver) => createNoopSigner(approver)),
        record,
        upload: published,
      });
    const check = (proposed: readonly Instruction[]) =>
      checkRegistration({
        client,
        settings,
        record,
        upload: uploaded,
        member: bob,
        approvers,
        proposed,
      });
    const honest = await register(uploaded);
    await check([honest]);
    await assert.rejects(
      check([await register(await newAddress())]),
      /instruction 0/,
    );
    await assert.rejects(check([honest, honest]), /expected 1/);
  });

  it("compares programs, accounts, roles and data", async () => {
    const instruction: Instruction = {
      programAddress: await newAddress(),
      accounts: [{ address: await newAddress(), role: AccountRole.READONLY }],
      data: Uint8Array.of(1, 2, 3),
    };
    const [account] = instruction.accounts ?? [];
    assert.ok(account);
    checkInstructionsMatch([instruction], [{ ...instruction }]);
    const different: Instruction[] = [
      { ...instruction, programAddress: await newAddress() },
      { ...instruction, accounts: [] },
      {
        ...instruction,
        accounts: [{ ...account, address: await newAddress() }],
      },
      {
        ...instruction,
        accounts: [{ ...account, role: AccountRole.WRITABLE }],
      },
      { ...instruction, data: Uint8Array.of(1, 2, 4) },
      { ...instruction, data: Uint8Array.of(1, 2) },
    ];
    for (const other of different) {
      assert.throws(
        () => checkInstructionsMatch([instruction], [other]),
        /instruction 0/,
      );
    }
  });
});
