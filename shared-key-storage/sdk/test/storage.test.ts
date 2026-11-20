/**
 * Storage on the SPL Record program, run end to end in LiteSVM against the
 * Record binary dumped from mainnet (`test/fixtures/spl_record.so`).
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  AccountRole,
  addSignersToInstruction,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { ByteWriter } from "../src/bytes.js";
import {
  RECORD_HEADER_SIZE,
  RECORD_PROGRAM_ADDRESS,
  STORAGE_CHUNK_SIZE,
  checkUploadedRecord,
  decodeRecordAccount,
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
  type StorageRpc,
} from "../src/storage.js";

const RECORD_SO = fileURLToPath(
  new URL("./fixtures/spl_record.so", import.meta.url),
);
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const transactionEncoder = getTransactionEncoder();

/** A LiteSVM with the mainnet Record binary and two funded wallets. */
class Chain {
  readonly svm = new LiteSVM();

  constructor() {
    this.svm.addProgramFromFile(RECORD_PROGRAM_ADDRESS, RECORD_SO);
  }

  async wallet(sol = 10n): Promise<KeyPairSigner> {
    const signer = await generateKeyPairSigner();
    this.svm.airdrop(signer.address, lamports(sol * 1_000_000_000n));
    return signer;
  }

  /** `StorageRpc` reading this chain's accounts. */
  get rpc(): StorageRpc {
    const svm = this.svm;
    return {
      getAccountInfo: (account: Address) => ({
        send: async () => {
          const found = svm.getAccount(account);
          return {
            context: { slot: 0n },
            value: found.exists
              ? {
                  data: [Buffer.from(found.data).toString("base64"), "base64"],
                  executable: found.executable,
                  lamports: found.lamports,
                  owner: found.programAddress,
                  space: BigInt(found.data.length),
                }
              : null,
          };
        },
      }),
    } as unknown as StorageRpc;
  }

  balance(account: Address): bigint {
    return this.svm.getBalance(account) ?? 0n;
  }

  exists(account: Address): boolean {
    return this.svm.getAccount(account).exists;
  }

  /** Signs with `feePayer` plus `signers` and returns the wire size. */
  async send(
    feePayer: TransactionSigner,
    instructions: readonly Instruction[],
    signers: readonly TransactionSigner[] = [],
  ): Promise<number> {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) =>
        appendTransactionMessageInstructions(
          instructions.map((ix) => addSignersToInstruction([...signers], ix)),
          m,
        ),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    const result = this.svm.sendTransaction(transaction);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`transaction failed: ${result.toString()}`);
    }
    this.svm.expireBlockhash();
    return transactionEncoder.encode(transaction).length;
  }

  async upload(
    payer: KeyPairSigner,
    upload: RecordUpload,
    count = upload.transactions.length,
  ): Promise<void> {
    for (const instructions of upload.transactions.slice(0, count)) {
      await this.send(payer, instructions);
    }
  }

  async publish(
    owner: KeyPairSigner,
    upload: RecordUpload,
    predecessor: PublishedRecord | undefined,
    bytes: Uint8Array,
  ): Promise<Instruction[]> {
    const instructions = await publishRecordInstructions(this.rpc, {
      owner: owner.address,
      upload,
      predecessor,
      bytes,
    });
    await this.send(owner, instructions, [owner]);
    return instructions;
  }
}

function recordBytes(length: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 251);
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
    const bytes = recordBytes(2800);
    const upload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes,
    });
    assert.equal(upload.refund, payer.address);
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
      revision: 1n,
      refund: payer.address,
      bytes,
    });
    const pointer = chain.svm.getAccount(
      await storagePointerAddress(owner.address),
    );
    assert.ok(pointer.exists);
    assert.equal(pointer.programAddress, RECORD_PROGRAM_ADDRESS);
    assert.equal(decodeRecordAccount(pointer.data).authority, owner.address);
  });

  it("replaces the record, closes the predecessor and refunds its destination", async () => {
    const chain = new Chain();
    const [owner, payer, sponsor, destination] = await Promise.all([
      chain.wallet(),
      chain.wallet(),
      chain.wallet(),
      chain.wallet(),
    ]);
    const first = recordBytes(900, 1);
    const firstUpload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      refund: destination.address,
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
    const destinationBefore = chain.balance(destination.address);
    await chain.publish(owner, secondUpload, published, second);

    assert.deepEqual(await fetchPublishedRecord(chain.rpc, owner.address), {
      address: secondUpload.address,
      revision: 2n,
      refund: sponsor.address,
      bytes: second,
    });
    assert.equal(chain.exists(firstUpload.address), false);
    assert.equal(
      chain.balance(destination.address),
      destinationBefore + firstRent,
    );
    // Republishing the current record would close what the pointer names.
    const current = await fetchPublishedRecord(chain.rpc, owner.address);
    assert.ok(current);
    await assert.rejects(
      publishRecordInstructions(chain.rpc, {
        owner: owner.address,
        upload: secondUpload,
        predecessor: current,
        bytes: second,
      }),
      /with itself/,
    );
  });

  it("lets the payer cancel an upload only before the authority handover", async () => {
    const chain = new Chain();
    const [owner, payer, destination] = await Promise.all([
      chain.wallet(),
      chain.wallet(),
      chain.wallet(),
    ]);
    const bytes = recordBytes(2000);
    const pending = await prepareRecordUpload({
      owner: owner.address,
      payer,
      refund: destination.address,
      bytes,
    });
    await chain.upload(payer, pending, pending.transactions.length - 1);
    const rent = chain.balance(pending.address);
    const before = chain.balance(destination.address);
    await chain.send(payer, [pending.closeInstruction]);
    assert.equal(chain.exists(pending.address), false);
    assert.equal(chain.balance(destination.address), before + rent);

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
    const instructions = await chain.publish(owner, upload, undefined, bytes);
    // The prefund already covers the rent, so no transfer is needed.
    assert.equal(
      instructions.some((ix) => ix.data?.[0] === 2 && ix.data.length === 12),
      false,
    );
    assert.equal(
      (await fetchPublishedRecord(chain.rpc, owner.address))?.address,
      upload.address,
    );
  });

  it("refunds the owner when the destination has since become a program", async () => {
    const chain = new Chain();
    const [owner, payer] = await Promise.all([chain.wallet(), chain.wallet()]);
    // An executable account cannot be credited; here the destination is a
    // program from the start, as if a program had been deployed there later.
    const first = recordBytes(400, 3);
    const firstUpload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      refund: RECORD_PROGRAM_ADDRESS,
      bytes: first,
    });
    await chain.upload(payer, firstUpload);
    await chain.publish(owner, firstUpload, undefined, first);
    const published = await fetchPublishedRecord(chain.rpc, owner.address);
    assert.ok(published);
    const ownerBefore = chain.balance(owner.address);
    const firstRent = chain.balance(firstUpload.address);

    const second = recordBytes(400, 4);
    const secondUpload = await prepareRecordUpload({
      owner: owner.address,
      payer,
      bytes: second,
    });
    await chain.upload(payer, secondUpload);
    const instructions = await publishRecordInstructions(chain.rpc, {
      owner: owner.address,
      upload: secondUpload,
      predecessor: published,
      bytes: second,
    });
    const close = instructions.at(-1);
    assert.equal(close?.accounts?.[2]?.address, owner.address);
    await chain.send(owner, instructions, [owner]);
    assert.equal(chain.exists(firstUpload.address), false);
    // The owner paid the transaction fee and received the predecessor's rent.
    assert.equal(chain.balance(owner.address), ownerBefore + firstRent - 5000n);
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
      revision: 7n,
      dataHash: storageDataHash(Uint8Array.of(1, 2, 3)),
      refund: (await generateKeyPairSigner()).address,
    };
    const encoded = encodeStoragePointer(pointer);
    assert.deepEqual(decodeStoragePointer(encoded), pointer);
    assert.throws(() => decodeStoragePointer(encoded.subarray(1)));
    const badMagic = flipped(encoded, 0);
    assert.throws(
      () => decodeStoragePointer(badMagic),
      /not a storage pointer/,
    );
    assert.throws(
      () =>
        decodeStoragePointer(
          encodeStoragePointer({ ...pointer, revision: 0n }),
        ),
      /no revision/,
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
