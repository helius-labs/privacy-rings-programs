/**
 * Storage on the SPL Record program, run end to end in LiteSVM against the
 * Record binary dumped from mainnet (`test/fixtures/spl_record.so`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  lamports,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { ByteWriter } from "../../src/bytes.js";
import {
  POINTER_DATA_SIZE,
  STORAGE_CHUNK_SIZE,
  checkUploadedRecord,
  decodeStoragePointer,
  encodeStoragePointer,
  fetchPublishedRecord,
  prepareRecordUpload,
  publishRecordInstructions,
  rentExemptLamports,
  storageDataHash,
  storagePointerAddress,
  type PublishedRecord,
  type RecordUpload,
} from "../../src/record/storage.js";
import {
  RECORD_HEADER_SIZE,
  RECORD_PROGRAM_ADDRESS,
  decodeRecordAccount,
} from "../../src/record/program.js";
import { Chain as BaseChain, FEE, recordBytes } from "../chain.js";

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
/** Logged by the Record program for `RecordError::IncorrectAuthority`. */
const INCORRECT_AUTHORITY_LOG = /Incorrect record authority provided/;

/** The shared chain, publishing with the owner as a plain signer. */
class Chain extends BaseChain {
  async publish(
    owner: KeyPairSigner,
    upload: RecordUpload,
    predecessor: PublishedRecord | undefined,
    bytes: Uint8Array,
  ): Promise<Instruction[]> {
    const instructions = await publishRecordInstructions({
      owner: owner.address,
      upload: upload.address,
      predecessor: predecessor?.address,
      bytes,
    });
    await this.send(owner, instructions, [owner]);
    return instructions;
  }
}

/** A copy of `bytes` with the byte at `index` flipped. */
function flipped(bytes: Uint8Array, index: number): Uint8Array {
  const value = bytes.at(index);
  if (value === undefined) throw new Error(`no byte at ${index}`);
  const copy = Uint8Array.from(bytes);
  copy.set([value ^ 1], index);
  return copy;
}

/** The worst case an upload transaction must fit: compute budget and a separate fee payer. */
function computeBudget(): Instruction[] {
  return [
    {
      programAddress: COMPUTE_BUDGET,
      data: new ByteWriter().u8(2).u32(200_000).finish(),
    },
    {
      programAddress: COMPUTE_BUDGET,
      data: new ByteWriter().u8(3).u64(1_000n).finish(),
    },
  ];
}

describe("storage on the SPL Record program", () => {
  it("uploads in transactions that fit 1,232 bytes and freezes the record under the owner", async () => {
    const chain = new Chain();
    const [owner, payer, feePayer] = await Promise.all([
      chain.wallet(),
      chain.wallet(),
      chain.wallet(),
    ]);
    // Whole chunks, so the last write is full and also hands over authority.
    const bytes = recordBytes(3 * STORAGE_CHUNK_SIZE);
    const upload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    // Create, then one write per chunk; the last also hands over authority.
    assert.equal(
      upload.transactions.length,
      1 + Math.ceil(bytes.length / STORAGE_CHUNK_SIZE),
    );
    for (const instructions of upload.transactions) {
      const size = await chain.send(feePayer, [
        ...computeBudget(),
        ...instructions,
      ]);
      assert.ok(size <= 1232, `upload transaction is ${size} bytes`);
    }
    const account = chain.svm.getAccount(upload.address);
    assert.ok(account.exists);
    assert.equal(account.programAddress, RECORD_PROGRAM_ADDRESS);
    assert.equal(
      account.lamports,
      rentExemptLamports(RECORD_HEADER_SIZE + bytes.length),
    );
    assert.deepEqual(decodeRecordAccount(account.data), {
      authority: owner.address,
      data: bytes,
    });
    await checkUploadedRecord(chain.rpc, owner.address, upload.address, bytes);
  });

  it("publishes the first record through a pointer the owner controls", async () => {
    const chain = new Chain();
    const [owner, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    assert.equal(
      await fetchPublishedRecord(chain.rpc, owner.address),
      undefined,
    );
    const bytes = recordBytes(1000);
    const upload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    await chain.upload(payer, upload);
    await chain.publish(owner, upload, undefined, bytes);
    assert.deepEqual(await fetchPublishedRecord(chain.rpc, owner.address), {
      address: upload.address,
      bytes,
    });
    const pointer = chain.svm.getAccount(
      await storagePointerAddress(owner.address),
    );
    assert.ok(pointer.exists);
    assert.equal(pointer.programAddress, RECORD_PROGRAM_ADDRESS);
    assert.equal(decodeRecordAccount(pointer.data).authority, owner.address);
  });

  it("replaces the record, closes the predecessor and sends its rent to the owner", async () => {
    const chain = new Chain();
    const [owner, payer, sponsor] = await Promise.all([
      chain.wallet(),
      chain.wallet(),
      chain.wallet(),
    ]);
    const first = recordBytes(900, 1);
    const firstUpload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes: first,
    });
    await chain.upload(payer, firstUpload);
    await chain.publish(owner, firstUpload, undefined, first);
    const published = await fetchPublishedRecord(chain.rpc, owner.address);
    assert.ok(published);

    const second = recordBytes(1700, 2);
    const secondUpload = await prepareRecordUpload({
      owner: owner.address,
      payer: sponsor,
      bytes: second,
    });
    await chain.upload(sponsor, secondUpload);
    assert.deepEqual(
      await fetchPublishedRecord(chain.rpc, owner.address),
      published,
      "an upload leaves the published record unchanged",
    );
    const firstRent = chain.balance(firstUpload.address);
    const ownerBefore = chain.balance(owner.address);
    const payerBefore = chain.balance(payer.address);
    await chain.publish(owner, secondUpload, published, second);

    assert.deepEqual(await fetchPublishedRecord(chain.rpc, owner.address), {
      address: secondUpload.address,
      bytes: second,
    });
    assert.equal(chain.exists(firstUpload.address), false);
    // The owner paid the transaction fee and received the predecessor's rent;
    // the predecessor's payer got nothing back.
    assert.equal(chain.balance(owner.address), ownerBefore + firstRent - FEE);
    assert.equal(chain.balance(payer.address), payerBefore);
    // Republishing the current record would close what the pointer names.
    await assert.rejects(
      publishRecordInstructions({
        owner: owner.address,
        upload: secondUpload.address,
        predecessor: secondUpload.address,
        bytes: second,
      }),
      /with itself/,
    );
  });

  it("builds the same instructions from the same input", async () => {
    const [owner, upload, predecessor] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const bytes = recordBytes(200);
    for (const replaced of [undefined, predecessor.address]) {
      const input = {
        owner: owner.address,
        upload: upload.address,
        predecessor: replaced,
        bytes,
      };
      assert.deepEqual(
        await publishRecordInstructions(input),
        await publishRecordInstructions(input),
      );
    }
  });

  it("cannot publish an upload its payer still controls, or one that does not exist", async () => {
    const chain = new Chain();
    const [owner, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const bytes = recordBytes(1600);
    const upload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    // Nothing sent yet: the upload account does not exist.
    await assert.rejects(
      chain.publish(owner, upload, undefined, bytes),
      /InvalidAccountData/,
    );
    // Everything but the handover: the payer is still the authority.
    await chain.upload(payer, upload, upload.transactions.length - 1);
    await assert.rejects(
      chain.publish(owner, upload, undefined, bytes),
      INCORRECT_AUTHORITY_LOG,
    );
    assert.equal(
      chain.exists(await storagePointerAddress(owner.address)),
      false,
      "a rejected publication creates no pointer",
    );

    // The same holds when replacing a published record.
    const first = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    await chain.upload(payer, first);
    await chain.publish(owner, first, undefined, bytes);
    const published = await fetchPublishedRecord(chain.rpc, owner.address);
    assert.ok(published);
    await assert.rejects(
      chain.publish(owner, upload, published, bytes),
      INCORRECT_AUTHORITY_LOG,
    );
    assert.deepEqual(
      await fetchPublishedRecord(chain.rpc, owner.address),
      published,
    );
  });

  it("rejects a repeated first publication and a replacement of a closed record", async () => {
    const chain = new Chain();
    const [owner, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const uploads: RecordUpload[] = [];
    const contents = [1, 2, 3].map((seed) => recordBytes(300, seed));
    for (const bytes of contents) {
      const upload = await prepareRecordUpload({
        owner: owner.address,
        payer,
        bytes,
      });
      await chain.upload(payer, upload);
      uploads.push(upload);
    }
    const [first, second, third] = uploads;
    const [firstBytes, secondBytes, thirdBytes] = contents;
    assert.ok(first && second && third);
    assert.ok(firstBytes && secondBytes && thirdBytes);

    await chain.publish(owner, first, undefined, firstBytes);
    const afterFirst = await fetchPublishedRecord(chain.rpc, owner.address);
    assert.ok(afterFirst);
    // The pointer exists, so a second first publication cannot allocate it.
    await assert.rejects(
      chain.publish(owner, second, undefined, secondBytes),
      /already in use/,
    );
    assert.deepEqual(
      await fetchPublishedRecord(chain.rpc, owner.address),
      afterFirst,
    );

    await chain.publish(owner, second, afterFirst, secondBytes);
    const afterSecond = await fetchPublishedRecord(chain.rpc, owner.address);
    assert.ok(afterSecond);
    // A publication approved against the first record is stale: that record
    // is closed, so closing it again fails the whole transaction.
    await assert.rejects(
      chain.publish(owner, third, afterFirst, thirdBytes),
      /InvalidAccountData/,
    );
    assert.deepEqual(
      await fetchPublishedRecord(chain.rpc, owner.address),
      afterSecond,
    );
  });

  it("lets the payer cancel an upload only before the authority handover", async () => {
    const chain = new Chain();
    const [owner, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const bytes = recordBytes(2000);
    const pending = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    await chain.upload(payer, pending, pending.transactions.length - 1);
    const rent = chain.balance(pending.address);
    const before = chain.balance(payer.address);
    await chain.send(payer, [pending.closeInstruction]);
    assert.equal(chain.exists(pending.address), false);
    // The payer paid the transaction fee and got the rent back.
    assert.equal(chain.balance(payer.address), before + rent - FEE);

    const frozen = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    await chain.upload(payer, frozen);
    await assert.rejects(chain.send(payer, [frozen.closeInstruction]));
    assert.equal(chain.exists(frozen.address), true);
  });

  it("publishes even when someone prefunded the pointer address", async () => {
    const chain = new Chain();
    const [owner, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const pointer = await storagePointerAddress(owner.address);
    chain.svm.airdrop(pointer, lamports(5_000_000n));
    const bytes = recordBytes(300);
    const upload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    await chain.upload(payer, upload);
    await chain.publish(owner, upload, undefined, bytes);
    // The owner still sends the full rent, so the pointer keeps the prefund.
    assert.equal(
      chain.balance(pointer),
      5_000_000n + rentExemptLamports(RECORD_HEADER_SIZE + POINTER_DATA_SIZE),
    );
    assert.equal(
      (await fetchPublishedRecord(chain.rpc, owner.address))?.address,
      upload.address,
    );
  });

  it("rejects uploads approvers must not sign", async () => {
    const chain = new Chain();
    const [owner, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const bytes = recordBytes(1600);
    const upload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    // Before the handover the payer can still change the bytes.
    await chain.upload(payer, upload, upload.transactions.length - 1);
    await assert.rejects(
      checkUploadedRecord(chain.rpc, owner.address, upload.address, bytes),
      /not controlled by/,
    );
    await chain.upload(payer, {
      ...upload,
      transactions: upload.transactions.slice(-1),
    });
    const other = flipped(bytes, 0);
    await assert.rejects(
      checkUploadedRecord(chain.rpc, owner.address, upload.address, other),
      /approved bytes/,
    );
    await checkUploadedRecord(chain.rpc, owner.address, upload.address, bytes);
  });

  it("rejects a record that does not match its pointer", async () => {
    const chain = new Chain();
    const [owner, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    const bytes = recordBytes(500);
    const upload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    await chain.upload(payer, upload);
    await chain.publish(owner, upload, undefined, bytes);
    const account = chain.svm.getAccount(upload.address);
    assert.ok(account.exists);
    const tampered = flipped(account.data, RECORD_HEADER_SIZE);
    chain.svm.setAccount({ ...account, data: tampered });
    await assert.rejects(
      fetchPublishedRecord(chain.rpc, owner.address),
      /does not match its pointer/,
    );
  });
});

describe("storage pointer encoding", () => {
  it("round-trips and rejects malformed pointers", async () => {
    const pointer = {
      current: (await generateKeyPairSigner()).address,
      dataHash: storageDataHash(Uint8Array.of(1, 2, 3)),
    };
    const encoded = encodeStoragePointer(pointer);
    assert.equal(encoded.length, POINTER_DATA_SIZE);
    assert.deepEqual(decodeStoragePointer(encoded), pointer);
    assert.throws(() => decodeStoragePointer(encoded.subarray(1)));
    assert.throws(() => decodeStoragePointer(Uint8Array.of(...encoded, 0)));
    const badMagic = flipped(encoded, 0);
    assert.throws(
      () => decodeStoragePointer(badMagic),
      /not a storage pointer/,
    );
  });

  it("writes Record instructions in the program's own format", async () => {
    const owner = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const bytes = recordBytes(10);
    const upload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    const [create, write] = upload.transactions;
    // Initialize: tag 0, record and authority.
    assert.deepEqual(create?.[1]?.data, Uint8Array.of(0));
    // Write: tag 1, u64 offset, u32 length, bytes.
    assert.deepEqual(
      write?.[0]?.data,
      new ByteWriter().u8(1).u64(0n).u32(10).bytes(bytes).finish(),
    );
    // SetAuthority: tag 2, record, current authority (signer), new authority.
    assert.deepEqual(write?.[1]?.data, Uint8Array.of(2));
    assert.deepEqual(
      write?.[1]?.accounts?.map(({ address, role }) => ({ address, role })),
      [
        { address: upload.address, role: AccountRole.WRITABLE },
        { address: payer.address, role: AccountRole.READONLY_SIGNER },
        { address: owner.address, role: AccountRole.READONLY },
      ],
    );
    // CloseAccount: tag 3, record, authority, destination.
    assert.deepEqual(upload.closeInstruction.data, Uint8Array.of(3));
  });
});
