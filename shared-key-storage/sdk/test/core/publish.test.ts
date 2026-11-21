/**
 * Create, update and remove of a key record, with a plain keypair as the
 * vault, in LiteSVM against the Record binary dumped from mainnet. LiteSVM
 * has no user registry program, so the registry instruction is compared with
 * the one `registry.ts` builds and the Record instructions are sent.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import type { SprClient } from "@heliuslabs/spr/client";
import { ShieldedKeypair, initializePoseidon } from "@heliuslabs/spr/keypair";

import {
  createKeyRecordInstructions,
  updateKeyRecordInstructions,
} from "../../src/core/publish.js";
import { memberFromKeypair, type Member } from "../../src/core/member.js";
import { recoverRecordKeys } from "../../src/core/recover.js";
import { createKeyRecord, rotatedKeyRecord } from "../../src/core/rotate.js";
import {
  registerVaultKeysInstruction,
  updateKeysInstruction,
} from "../../src/registry.js";
import {
  fetchPublishedKeyRecord,
  prepareKeyRecordUpload,
} from "../../src/record/keyRecordStorage.js";
import {
  fetchPublishedRecord,
  removeRecordInstructions,
  storagePointerAddress,
} from "../../src/record/storage.js";
import { Chain } from "../chain.js";

/** Logged by the Record program for `RecordError::IncorrectAuthority`. */
const INCORRECT_AUTHORITY_LOG = /Incorrect record authority provided/;

function newMember(): Member {
  return memberFromKeypair(ShieldedKeypair.generate());
}

function recipient(member: Member) {
  return {
    key: member.signer.address,
    viewingPublicKey: member.keypair.viewingPublicKey(),
  };
}

function client(chain: Chain): SprClient {
  return { solanaRpc: chain.rpc } as unknown as SprClient;
}

describe("key record publication", () => {
  before(async () => {
    await initializePoseidon();
  });

  it("creates record 0, updates it and removes it", async () => {
    const chain = new Chain();
    const [vault, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const [alice, bob, carol] = [newMember(), newMember(), newMember()];

    // Create: record 0 for Alice and Bob.
    const first = createKeyRecord({
      accountId: vault.address,
      recipients: [recipient(alice), recipient(bob)],
    });
    assert.equal(first.epoch, 0n);
    const firstUpload = await prepareKeyRecordUpload({
      owner: vault.address,
      payer,
      record: first,
    });
    await chain.upload(payer, firstUpload);
    const [register, ...publishFirst] = await createKeyRecordInstructions({
      vault: vault.address,
      record: first,
      upload: firstUpload.address,
    });
    assert.deepEqual(
      register,
      await registerVaultKeysInstruction(vault.address, first),
    );
    await chain.send(payer, publishFirst, [vault]);
    assert.deepEqual(
      await fetchPublishedKeyRecord(client(chain), vault.address),
      {
        address: firstUpload.address,
        record: first,
      },
    );

    // Update: Alice replaces Bob with Carol.
    const second = rotatedKeyRecord({
      accountId: vault.address,
      record: first,
      rotator: alice,
      recipients: [recipient(alice), recipient(carol)],
    });
    assert.equal(second.epoch, 1n);
    const secondUpload = await prepareKeyRecordUpload({
      owner: vault.address,
      payer,
      record: second,
    });
    await chain.upload(payer, secondUpload);
    const [updateKeys, ...publishSecond] = await updateKeyRecordInstructions({
      vault: vault.address,
      record: second,
      upload: secondUpload.address,
      predecessor: firstUpload.address,
    });
    assert.deepEqual(
      updateKeys,
      await updateKeysInstruction(vault.address, second.sharedViewingPublicKey),
    );
    await chain.send(payer, publishSecond, [vault]);
    assert.deepEqual(
      await fetchPublishedKeyRecord(client(chain), vault.address),
      {
        address: secondUpload.address,
        record: second,
      },
    );
    assert.equal(chain.exists(firstUpload.address), false);
    // Carol recovers the current viewing key and the one before she joined.
    assert.equal(recoverRecordKeys(second, carol).viewingKeys.length, 2);

    // Remove: both accounts close and their rent goes to the vault.
    const pointer = await storagePointerAddress(vault.address);
    const rent = chain.balance(secondUpload.address) + chain.balance(pointer);
    const before = chain.balance(vault.address);
    await chain.send(
      payer,
      await removeRecordInstructions({
        owner: vault.address,
        current: secondUpload.address,
      }),
      [vault],
    );
    assert.equal(chain.balance(vault.address), before + rent);
    assert.equal(chain.exists(secondUpload.address), false);
    assert.equal(chain.exists(pointer), false);
    assert.equal(
      await fetchPublishedRecord(chain.rpc, vault.address),
      undefined,
    );
  });

  it("publishes a first record again after a removal", async () => {
    const chain = new Chain();
    const [vault, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const alice = newMember();
    const record = createKeyRecord({
      accountId: vault.address,
      recipients: [recipient(alice)],
    });
    for (const round of [1, 2]) {
      const upload = await prepareKeyRecordUpload({
        owner: vault.address,
        payer,
        record,
      });
      await chain.upload(payer, upload);
      const [, ...publish] = await createKeyRecordInstructions({
        vault: vault.address,
        record,
        upload: upload.address,
      });
      await chain.send(payer, publish, [vault]);
      assert.equal(
        (await fetchPublishedRecord(chain.rpc, vault.address))?.address,
        upload.address,
        `publication ${round}`,
      );
      await chain.send(
        payer,
        await removeRecordInstructions({
          owner: vault.address,
          current: upload.address,
        }),
        [vault],
      );
    }
  });

  it("does not remove a record the vault does not control", async () => {
    const chain = new Chain();
    const [vault, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const alice = newMember();
    const record = createKeyRecord({
      accountId: vault.address,
      recipients: [recipient(alice)],
    });
    const upload = await prepareKeyRecordUpload({
      owner: vault.address,
      payer,
      record,
    });
    await chain.upload(payer, upload);
    const [, ...publish] = await createKeyRecordInstructions({
      vault: vault.address,
      record,
      upload: upload.address,
    });
    await chain.send(payer, publish, [vault]);

    // An upload whose last transaction was not sent: the payer controls it.
    const unfrozen = await prepareKeyRecordUpload({
      owner: vault.address,
      payer,
      record,
    });
    await chain.upload(payer, unfrozen, unfrozen.transactions.length - 1);
    await assert.rejects(
      chain.send(
        payer,
        await removeRecordInstructions({
          owner: vault.address,
          current: unfrozen.address,
        }),
        [vault],
      ),
      INCORRECT_AUTHORITY_LOG,
    );
    // The failed removal left the published record and its pointer in place.
    assert.equal(
      (await fetchPublishedRecord(chain.rpc, vault.address))?.address,
      upload.address,
    );
  });

  it("refuses to create from a record that is not record 0", async () => {
    const chain = new Chain();
    const vault = await chain.wallet();
    const alice = newMember();
    const first = createKeyRecord({
      accountId: vault.address,
      recipients: [recipient(alice)],
    });
    const second = rotatedKeyRecord({
      accountId: vault.address,
      record: first,
      rotator: alice,
      recipients: [recipient(alice)],
    });
    await assert.rejects(
      createKeyRecordInstructions({
        vault: vault.address,
        record: second,
        upload: vault.address,
      }),
      /the first key record is record 0, not 1/,
    );
  });
});
