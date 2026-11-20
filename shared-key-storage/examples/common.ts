/** Connection, keypair and transaction helpers shared by the examples. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import {
  AccountRole,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  getSignatureFromTransaction,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@heliuslabs/shared-key-storage";

export type SolanaRpc = Rpc<SolanaRpcApi>;

/**
 * Connects to `SOLANA_RPC_URL` and loads the wallet at `PAYER_KEYPAIR`
 * (default `~/.config/solana/id.json`). The wallet owns the record, pays the
 * rent and signs every transaction.
 */
export async function setup(): Promise<
  Readonly<{ rpc: SolanaRpc; wallet: KeyPairSigner }>
> {
  const rpcUrl = process.env["SOLANA_RPC_URL"]?.trim();
  if (!rpcUrl) throw new Error("set SOLANA_RPC_URL, e.g. a devnet RPC URL");
  const rpc = createSolanaRpc(rpcUrl);
  const wallet = await loadKeypair(
    process.env["PAYER_KEYPAIR"]?.trim() || "~/.config/solana/id.json",
  );
  return { rpc, wallet };
}

async function loadKeypair(path: string): Promise<KeyPairSigner> {
  const resolved = path.startsWith("~/")
    ? `${homedir()}/${path.slice(2)}`
    : path;
  const secret: unknown = JSON.parse(await readFile(resolved, "utf8"));
  if (
    !Array.isArray(secret) ||
    secret.length !== 64 ||
    secret.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error(`invalid Solana keypair at ${resolved}`);
  }
  const bytes = Uint8Array.from(secret);
  try {
    return await createKeyPairSignerFromBytes(bytes);
  } finally {
    bytes.fill(0);
    secret.fill(0);
  }
}

/** The record to publish: the file at `path`, or `sample` without one. */
export async function recordBytes(
  sample: string,
  path: string | undefined,
): Promise<Uint8Array> {
  if (path !== undefined) return new Uint8Array(await readFile(path));
  return new TextEncoder().encode(sample);
}

/** Signs with every signer the instructions name and waits for confirmation. */
export async function send(
  rpc: SolanaRpc,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<Signature> {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(feePayer, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) => appendTransactionMessageInstructions(instructions, message),
    ),
  );
  assertIsTransactionWithBlockhashLifetime(signed);
  await sendTransactionWithoutConfirmingFactory({ rpc })(signed, {
    commitment: "confirmed",
  });
  const signature = getSignatureFromTransaction(signed);
  await confirm(rpc, signature, lifetime.lastValidBlockHeight);
  return signature;
}

/**
 * Polls the signature until it is confirmed, it fails, or its blockhash
 * expires.
 */
async function confirm(
  rpc: SolanaRpc,
  signature: Signature,
  lastValidBlockHeight: bigint,
): Promise<void> {
  for (;;) {
    const {
      value: [status],
    } = await rpc.getSignatureStatuses([signature]).send();
    if (status?.err) {
      throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }
    const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (height > lastValidBlockHeight) {
      throw new Error(`${signature} expired before confirmation`);
    }
    await sleep(500);
  }
}

/** Sends each upload transaction, in order. */
export async function upload(
  rpc: SolanaRpc,
  wallet: KeyPairSigner,
  transactions: readonly (readonly Instruction[])[],
): Promise<void> {
  for (const [index, instructions] of transactions.entries()) {
    const signature = await send(rpc, wallet, instructions);
    console.log(`  step ${index + 1}/${transactions.length}: ${signature}`);
  }
}

/**
 * The Swig roles' recurring SOL budget for rent and fees paid by the Swig's
 * wallet address: 0.05 SOL per about a day of slots.
 */
export const SWIG_BUDGET = { lamports: 50_000_000n, window: 216_000n };

/** A System Program transfer that `from` signs. */
export function transferSol(
  from: KeyPairSigner,
  to: Address,
  lamports: bigint,
): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  const source: AccountSignerMeta = {
    address: from.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: from,
  };
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [source, { address: to, role: AccountRole.WRITABLE }],
    data,
  };
}

/** The account's data at `confirmed`; fails if it does not exist. */
export async function accountData(
  rpc: SolanaRpc,
  account: Address,
): Promise<Uint8Array> {
  const fetched = await fetchEncodedAccount(rpc, account, {
    commitment: "confirmed",
  });
  if (!fetched.exists) throw new Error(`${account} does not exist`);
  return fetched.data;
}

/** The account's lamports at `confirmed`. */
export async function balance(
  rpc: SolanaRpc,
  account: Address,
): Promise<bigint> {
  const { value } = await rpc
    .getBalance(account, { commitment: "confirmed" })
    .send();
  return value;
}
