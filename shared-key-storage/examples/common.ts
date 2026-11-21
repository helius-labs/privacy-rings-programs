/**
 * Connection, keypair and transaction helpers shared by the examples, and the
 * setup of the spend example.
 */
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
  setTransactionMessageConfig,
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
import { SOL_MINT, Wallet, createSprClient, syncWallet } from "@heliuslabs/spr";
import { SignedTeePolicy, type SprClient } from "@heliuslabs/spr/client";
import { DepositAsset, depositInstruction } from "@heliuslabs/spr/interface";
import {
  ShieldedAddress,
  ShieldedKeypair,
  X25519PublicKey,
  initializePoseidon,
} from "@heliuslabs/spr/keypair";
import {
  AssetRegistry,
  type LocalShieldedKeys,
} from "@heliuslabs/spr/transaction";
import {
  Permission,
  SYSTEM_PROGRAM_ADDRESS,
  createSmartAccount,
  memberFromKeypair,
  prepareKeyRecordUpload,
  registerVaultInstruction,
  type Member,
} from "@heliuslabs/shared-key-storage";

export type SolanaRpc = Rpc<SolanaRpcApi>;

/**
 * Connects to `SOLANA_RPC_URL` and loads the wallet at `PAYER_KEYPAIR`
 * (default `~/.config/solana/id.json`). The wallet owns the record, pays the
 * rent and signs every transaction.
 */
export async function setup(): Promise<
  Readonly<{ rpc: SolanaRpc; rpcUrl: string; wallet: KeyPairSigner }>
> {
  const rpcUrl = process.env["SOLANA_RPC_URL"]?.trim();
  if (!rpcUrl) throw new Error("set SOLANA_RPC_URL, e.g. a devnet RPC URL");
  const rpc = createSolanaRpc(rpcUrl);
  const wallet = await loadKeypair(
    process.env["PAYER_KEYPAIR"]?.trim() || "~/.config/solana/id.json",
  );
  return { rpc, rpcUrl, wallet };
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

/**
 * Signs with every signer the instructions name and waits for confirmation.
 * `large` sends a version 1 transaction (up to 4,096 bytes) with the maximum
 * compute, which shielded pool instructions and their proofs need.
 */
export async function send(
  rpc: SolanaRpc,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
  { large = false }: Readonly<{ large?: boolean }> = {},
): Promise<Signature> {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const empty = large
    ? setTransactionMessageConfig(
        {
          computeUnitLimit: 1_400_000,
          loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
        },
        createTransactionMessage({ version: 1 }),
      )
    : createTransactionMessage({ version: 0 });
  const signed = await signTransactionMessageWithSigners(
    pipe(
      empty,
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

/** Lamports deposited into the vault's shielded balance. */
export const DEPOSIT = 10_000_000n;
/** Lamports for the vault's own rent and fees: registry record and SPP fees. */
const VAULT_SOL = 20_000_000n;

const NETWORKS: Readonly<Record<string, "devnet" | "mainnet">> = {
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
};

/**
 * 1. Connect to the shielded pool and attest its prover.
 * 2. Create the smart account with key record 0 for the member, and fund its
 *    vault.
 * 3. Upload record 0 and Register: the vault registers its shared keys in
 *    the user registry and publishes the record.
 * 4. Deposit `DEPOSIT` into the vault's shielded address, which anyone can
 *    derive from the record's public keys.
 */
export async function setupPrivateSmartAccount(): Promise<
  Readonly<{
    client: SprClient;
    rpc: SolanaRpc;
    wallet: KeyPairSigner;
    member: Member;
    settings: Address;
    vault: Address;
  }>
> {
  const { rpc, rpcUrl, wallet } = await setup();
  const genesis = await rpc.getGenesisHash().send();
  const network = NETWORKS[genesis];
  if (network === undefined) throw new Error("use a devnet or mainnet RPC");
  await initializePoseidon();
  const client = await createSprClient({
    solanaRpcUrl: rpcUrl,
    proverTee: SignedTeePolicy.forNetwork(network),
    proofDataSource: "prover",
  });
  await client.attestProver();
  await client.checkProverProvingKeys();

  const member = memberFromKeypair(ShieldedKeypair.generate());
  const created = await createSmartAccount({
    client,
    creator: wallet,
    threshold: 1,
    signers: [
      {
        key: member.signer.address,
        permissions: Permission.All,
        viewingPublicKey: member.keypair.viewingPublicKey(),
      },
    ],
  });
  console.log(`create ${created.settings}`);
  await send(rpc, wallet, [
    created.instruction,
    transferSol(wallet, created.vault, VAULT_SOL),
  ]);

  console.log("upload key record 0");
  const recordUpload = await prepareKeyRecordUpload({
    owner: created.vault,
    payer: wallet,
    record: created.record,
  });
  await upload(rpc, wallet, recordUpload.transactions);
  const register = await registerVaultInstruction({
    client,
    settings: created.settings,
    approvers: [member.signer],
    record: created.record,
    upload: recordUpload.address,
  });
  console.log(
    `register: ${await send(rpc, wallet, [register], { large: true })}`,
  );

  const vault = ShieldedAddress.forPda({
    pda: created.vault,
    nullifierPublicKey: created.record.nullifierPublicKey,
    viewingPublicKey: X25519PublicKey.fromBytes(
      created.record.sharedViewingPublicKey,
    ),
  });
  const deposit = await depositInstruction({
    tree: client.tree,
    depositor: wallet,
    deposits: [
      {
        asset: DepositAsset.sol(),
        viewTag: vault.confidentialViewTag(),
        recipientOwnerHash: vault.ownerHash(),
        amount: DEPOSIT,
      },
    ],
  });
  console.log(
    `deposit: ${await send(rpc, wallet, [deposit], { large: true })}`,
  );
  return {
    client,
    rpc,
    wallet,
    member,
    settings: created.settings,
    vault: created.vault,
  };
}

/**
 * Syncs the shielded wallet of `address` until its SOL balance is
 * `expected`; the indexer can lag the RPC.
 */
export async function syncedBalance(
  client: SprClient,
  address: ShieldedAddress,
  keys: LocalShieldedKeys,
  expected: bigint,
): Promise<Wallet> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const wallet = new Wallet({
      identity: address,
      registry: new AssetRegistry(),
    });
    await syncWallet({ wallet, keys, client, config: { pageLimit: 50 } });
    if (wallet.balance(SOL_MINT).amount === expected) return wallet;
    await sleep(1000);
  }
  throw new Error(`${address.solanaAddress()} never reached ${expected}`);
}
