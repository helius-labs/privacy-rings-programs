/**
 * What the examples share: the connection, the four example members, sending
 * transactions, the key record upload, the recovery assertion and the vault's
 * shielded balance.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
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
import { getRegisterInstructionAsync } from "@heliuslabs/spr/instructions";
import { DepositAsset, depositInstruction } from "@heliuslabs/spr/interface";
import {
  ShieldedAddress,
  ShieldedKeypair,
  SigningKey,
  initializePoseidon,
  type Bytes32,
} from "@heliuslabs/spr/keypair";
import {
  AssetRegistry,
  type LocalShieldedKeys,
} from "@heliuslabs/spr/transaction";
import {
  destroyVaultSecrets,
  fetchRegisteredViewingKey,
  type KeyRecipient,
  type KeyRecord,
  type RecordUpload,
  type Member,
  memberFromKeypair,
  prepareKeyRecordUpload,
  SYSTEM_PROGRAM_ADDRESS,
  type VaultSecrets,
} from "@heliuslabs/shared-key-storage";

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** Lamports deposited into the vault's shielded balance by the spend examples. */
export const DEPOSIT = 10_000_000n;
/** Lamports for the vault's own rent and fees: registry record, pointer, SPP fees. */
export const VAULT_SOL = 20_000_000n;
/**
 * The Swig roles' recurring SOL budget for rent and fees paid by the Swig's
 * wallet address: 0.05 SOL per about a day of slots.
 */
export const SWIG_BUDGET = { lamports: 50_000_000n, window: 216_000n };

const NETWORKS: Readonly<Record<string, "devnet" | "mainnet">> = {
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
};

/** A member of the example wallets, with the name the scripts print. */
export interface NamedMember extends Member {
  readonly name: string;
}

export interface Session {
  readonly client: SprClient;
  readonly rpc: SolanaRpc;
  /** Your wallet: pays every fee and rent. It is also Alice's signer. */
  readonly wallet: KeyPairSigner;
  /**
   * Your wallet as a member: the same signer with the shielded keypair
   * derived from its secret key, which opens its key record entries.
   */
  readonly alice: NamedMember;
  /**
   * Three more members. A real wallet's members are separate people; here
   * their keys are derived from your wallet's secret key, so every script
   * can act as each of them without storing keys. Bob and Carol are members
   * from the start; a rotation swaps Carol and Dave.
   */
  readonly bob: NamedMember;
  readonly carol: NamedMember;
  readonly dave: NamedMember;
}

/**
 * Connects to `SOLANA_RPC_URL` and its shielded pool, and loads the wallet at
 * `PAYER_KEYPAIR` (default `~/.config/solana/id.json`). `prover` also attests
 * the pool's prover, which a spend needs.
 */
export async function connect({
  prover = false,
}: Readonly<{ prover?: boolean }> = {}): Promise<Session> {
  const rpcUrl = process.env["SOLANA_RPC_URL"]?.trim();
  if (!rpcUrl) throw new Error("set SOLANA_RPC_URL, e.g. a devnet RPC URL");
  const rpc = createSolanaRpc(rpcUrl);
  const network = NETWORKS[await rpc.getGenesisHash().send()];
  if (network === undefined) throw new Error("use a devnet or mainnet RPC");
  await initializePoseidon();
  const members = await loadKeypair(
    process.env["PAYER_KEYPAIR"]?.trim() || "~/.config/solana/id.json",
  );
  const client = await createSprClient({
    solanaRpcUrl: rpcUrl,
    proverTee: SignedTeePolicy.forNetwork(network),
    proofDataSource: "prover",
  });
  if (prover) {
    await client.attestProver();
    await client.checkProverProvingKeys();
  }
  return { client, rpc, ...members };
}

/** The member whose keys derive from the wallet's secret `seed` and `name`. */
function derivedMember(seed: Uint8Array, name: string): NamedMember {
  const secret = createHash("sha256")
    .update(seed)
    .update(`shared-key-storage example member ${name}`)
    .digest();
  try {
    const member = memberFromKeypair(
      ShieldedKeypair.fromKeypair(
        SigningKey.fromEd25519Bytes(Uint8Array.from(secret) as Bytes32),
      ),
    );
    return { ...member, name };
  } finally {
    secret.fill(0);
  }
}

async function loadKeypair(
  path: string,
): Promise<Omit<Session, "client" | "rpc">> {
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
    const wallet = await createKeyPairSignerFromBytes(bytes);
    // A Solana keypair file is the 32-byte secret seed, then the public key.
    const keypair = ShieldedKeypair.fromKeypair(
      SigningKey.fromEd25519Bytes(bytes.slice(0, 32) as Bytes32),
    );
    assert.equal(keypair.toSolanaSigner().address, wallet.address);
    // A view, so zeroing `bytes` below zeroes it too.
    const seed = bytes.subarray(0, 32);
    return {
      wallet,
      alice: { signer: wallet, keypair, name: "Alice" },
      bob: derivedMember(seed, "Bob"),
      carol: derivedMember(seed, "Carol"),
      dave: derivedMember(seed, "Dave"),
    };
  } finally {
    bytes.fill(0);
    secret.fill(0);
  }
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

/** The one command line argument of `pnpm <script> <name>`, as an address. */
export function addressArgument(script: string, name: string): Address {
  const [value] = process.argv.slice(2);
  if (value === undefined) {
    throw new Error(`usage: pnpm ${script} <${name}>`);
  }
  return address(value);
}

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

/**
 * Registers `member`'s own keys in the user registry unless they are there.
 * A rotation reads every kept signer's viewing key from the registry, so each
 * signer must be registered with the key its shielded keypair holds.
 */
export async function ensureRegistered(
  { client, rpc, wallet }: Session,
  member: Member,
): Promise<void> {
  const viewingPublicKey = member.keypair.viewingPublicKey().toBytes();
  const registered = await fetchRegisteredViewingKey(
    client,
    member.signer.address,
  );
  if (registered !== undefined) {
    assert.deepEqual(
      registered,
      viewingPublicKey,
      `${member.signer.address} is registered with another viewing key`,
    );
    return;
  }
  const register = await getRegisterInstructionAsync({
    owner: member.signer,
    payer: wallet,
    nullifierPublicKey: member.keypair.nullifierPublicKey(),
    viewingPublicKey,
  });
  console.log(
    `registered ${member.signer.address}: ${await send(rpc, wallet, [register])}`,
  );
}

/**
 * Uploads `record` into a new Record account in chunks and freezes it under
 * `vault`. Returns the account's address.
 */
export async function uploadKeyRecord(
  { rpc, wallet }: Pick<Session, "rpc" | "wallet">,
  vault: Address,
  record: KeyRecord,
): Promise<Address> {
  const prepared = await prepareKeyRecordUpload({
    owner: vault,
    payer: wallet,
    record,
  });
  await sendUpload({ rpc, wallet }, prepared);
  return prepared.address;
}

/** Sends the transactions of a prepared upload, in order. */
export async function sendUpload(
  { rpc, wallet }: Pick<Session, "rpc" | "wallet">,
  prepared: RecordUpload,
): Promise<void> {
  console.log(`uploading the key record to ${prepared.address}`);
  for (const [index, instructions] of prepared.transactions.entries()) {
    const signature = await send(rpc, wallet, instructions);
    console.log(
      `  step ${index + 1}/${prepared.transactions.length}: ${signature}`,
    );
  }
}

/**
 * The example members that are among `signers`, and the ones that are not.
 */
export function membersAmong(
  { alice, bob, carol, dave }: Session,
  signers: readonly Address[],
): Readonly<{ members: NamedMember[]; others: NamedMember[] }> {
  const all = [alice, bob, carol, dave];
  const isSigner = (member: NamedMember) =>
    signers.includes(member.signer.address);
  return {
    members: all.filter(isSigner),
    others: all.filter((member) => !isSigner(member)),
  };
}

/** `member` as a key record recipient. */
export function recipient(member: Member): KeyRecipient {
  return {
    key: member.signer.address,
    viewingPublicKey: member.keypair.viewingPublicKey(),
  };
}

/**
 * Asserts that each of `members` recovers the shared keys from the vault's
 * current key record, and each of `removed` does not. `recover` is the
 * wallet's recover helper.
 */
export async function assertMembersRecover(
  input: Readonly<{
    members: readonly NamedMember[];
    removed?: readonly NamedMember[];
    expected: KeyRecord;
    recover: (member: Member) => Promise<VaultSecrets>;
  }>,
): Promise<void> {
  for (const member of input.members) {
    const recovered = await input.recover(member);
    try {
      assertRecovered(member.name, recovered, input.expected);
    } finally {
      destroyVaultSecrets(recovered);
    }
  }
  for (const member of input.removed ?? []) {
    await assert.rejects(
      input.recover(member),
      /no entry/,
      `${member.name} is no longer a member`,
    );
    console.log(`${member.name} cannot recover: it has no entry`);
  }
}

/**
 * Asserts that `recovered`, what a member recovered from the vault's current
 * key record, is the record `expected` and holds its keys: the shared viewing
 * key, the nullifier key and one viewing key per epoch.
 */
function assertRecovered(
  name: string,
  recovered: VaultSecrets,
  expected: KeyRecord,
): void {
  assert.deepEqual(recovered.record, expected, "the current key record");
  assert.deepEqual(
    recovered.secrets.viewingKey.publicKey().toBytes(),
    expected.sharedViewingPublicKey,
    "the recovered shared viewing key",
  );
  assert.deepEqual(
    recovered.secrets.nullifierKey.publicKey(),
    expected.nullifierPublicKey,
    "the recovered nullifier key",
  );
  assert.equal(
    BigInt(recovered.viewingKeys.length),
    expected.epoch + 1n,
    "one viewing key for the current epoch and each earlier one",
  );
  console.log(
    `${name} recovered key record ${expected.epoch}: ${recovered.viewingKeys.length} viewing key(s)`,
  );
}

/** Deposits `DEPOSIT` into the vault's shielded address. */
export async function depositToVault(
  { client, rpc, wallet }: Session,
  vault: ShieldedAddress,
): Promise<void> {
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
    `deposit:  ${await send(rpc, wallet, [deposit], { large: true })}`,
  );
}

/** The shielded wallet of `address`, synced once with `keys`. */
export async function shieldedWallet(
  client: SprClient,
  address: ShieldedAddress,
  keys: LocalShieldedKeys,
): Promise<Wallet> {
  const wallet = new Wallet({
    identity: address,
    registry: new AssetRegistry(),
  });
  await syncWallet({ wallet, keys, client, config: { pageLimit: 50 } });
  return wallet;
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
    const wallet = await shieldedWallet(client, address, keys);
    if (wallet.balance(SOL_MINT).amount === expected) return wallet;
    await sleep(1000);
  }
  throw new Error(`${address.solanaAddress()} never reached ${expected}`);
}
