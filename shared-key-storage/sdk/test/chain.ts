/**
 * A LiteSVM chain for the storage tests, loaded with the Record program
 * binary dumped from mainnet (`test/fixtures/`).
 */
import { fileURLToPath } from "node:url";
import {
  addSignersToInstruction,
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
import { type RecordUpload, type StorageRpc } from "../src/record/storage.js";
import { RECORD_PROGRAM_ADDRESS } from "../src/record/program.js";

export const RECORD_SO = fixture("spl_record.so");
/** The fee of a transaction with one signature. */
export const FEE = 5000n;
const transactionEncoder = getTransactionEncoder();

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** A LiteSVM with the mainnet Record binary. */
export class Chain {
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

  /** The account's data; fails if it does not exist. */
  data(account: Address): Uint8Array {
    const found = this.svm.getAccount(account);
    if (!found.exists) throw new Error(`${account} does not exist`);
    return found.data;
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
}

export function recordBytes(length: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 251);
}
