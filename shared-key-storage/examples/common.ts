/** Connection, keypair and transaction helpers shared by the examples. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { createSprClient } from "@heliuslabs/spr";
import type { SprClient } from "@heliuslabs/spr/client";

/**
 * Connects to `SOLANA_RPC_URL` and loads the wallet at `PAYER_KEYPAIR`
 * (default `~/.config/solana/id.json`). The wallet owns the record, pays the
 * rent and signs every transaction.
 */
export async function setup(): Promise<
  Readonly<{ client: SprClient; wallet: KeyPairSigner }>
> {
  const rpcUrl = process.env["SOLANA_RPC_URL"]?.trim();
  if (!rpcUrl) throw new Error("set SOLANA_RPC_URL, e.g. a devnet RPC URL");
  const client = await createSprClient({ solanaRpcUrl: rpcUrl });
  const wallet = await loadKeypair(
    process.env["PAYER_KEYPAIR"]?.trim() || "~/.config/solana/id.json",
  );
  return { client, wallet };
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
  client: SprClient,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<Signature> {
  const { value: lifetime } = await client.solanaRpc
    .getLatestBlockhash()
    .send();
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
  await sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc })(
    signed,
    { commitment: "confirmed" },
  );
  const signature = getSignatureFromTransaction(signed);
  await client.confirmTransaction(signature);
  return signature;
}

/** Sends each upload chunk in its own transaction, in order. */
export async function upload(
  client: SprClient,
  wallet: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<void> {
  for (const [index, instruction] of instructions.entries()) {
    const signature = await send(client, wallet, [instruction]);
    console.log(`  chunk ${index + 1}/${instructions.length}: ${signature}`);
  }
}
