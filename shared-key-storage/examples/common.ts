/** Connection, keypair and transaction helpers shared by the examples. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";

type SolanaRpc = Rpc<SolanaRpcApi>;

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

/** The record to publish: the file named on the command line, or a sample. */
export async function recordBytes(sample: string): Promise<Uint8Array> {
  const path = process.argv[2];
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

/** Sends each upload chunk in its own transaction, in order. */
export async function upload(
  rpc: SolanaRpc,
  wallet: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<void> {
  for (const [index, instruction] of instructions.entries()) {
    const signature = await send(rpc, wallet, [instruction]);
    console.log(`  chunk ${index + 1}/${instructions.length}: ${signature}`);
  }
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
