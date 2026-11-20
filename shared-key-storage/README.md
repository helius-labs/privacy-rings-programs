# Shared Key Storage

A Squads smart account whose vault holds private balances in the zolana
shielded pool (SPP). Every signer views them through a shared viewing key,
which the signers encrypt to each other in a key record. Key records live in
accounts of the SPL Record program; no custom program is involved. Each
vault's pointer, a second Record account at a seeded address, names its
current record, and superseded records are closed. No proof checks a key
record. See [`design.md`](design.md) for the flows and their limitations.

> [!WARNING]
> **Not for production.** An example, not audited code. Nothing checks that a
> key record's ciphertexts open for every signer; see the limitations in
> `design.md`. The client uses the SPL Record program at
> `recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5` on devnet and mainnet. That
> program is also unaudited, and upgradeable by its maintainers.

## Layout

| Package                  | Contents                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| [`sdk/`](sdk/)           | TypeScript client for storage, key records, the user registry and private smart accounts. |
| [`examples/`](examples/) | Scripts that create and update a record with the raw storage SDK.                         |

## Storage on the SPL Record program

- **Record**: a Record account holding a 33-byte header (version, authority)
  and the key record bytes. A sponsor creates it, writes it in chunks and
  then hands its authority to the vault, which freezes the bytes.
- **Pointer**: a Record account at
  `createWithSeed(vault, "key-record-pointer", Record)`, owned by the vault.
  Its data is `SKRPTR01`, the current record's address, a revision, the
  SHA-256 of the record's bytes and the destination that gets the record's
  rent back when it is replaced.
- **Publication**: instructions the vault signs in one transaction. The first
  creates the pointer (allocate and assign, so prefunding its address cannot
  block it); a replacement rewrites it and closes the old record.

The Record program only enforces that the authority writes and closes. Every
other rule is in the SDK (`sdk/src/storage.ts`): readers accept a record only
if the pointer and the record are Record accounts controlled by the vault and
the bytes match the pointer's hash.

## Key record encryption

Each ciphertext is `AES-256-CTR(key, iv = 0, plaintext)` with
`key = HKDF-SHA256(X25519(e, R), salt = E || R, info)`, where `e`/`E` is the
record's ephemeral keypair and `R` the recipient's tagged viewing public key.
The info is `KEY_INFO` for the shared viewing secret (to each signer),
`NULLIFIER_INFO` for the nullifier secret and `OLD_KEY_INFO || LE32(i)` for
historical viewing secret i. The latter two are encrypted to the current
shared viewing key; the per-index info gives each old secret its own
encryption key. Decryption checks each secret against its advertised public
key.

`oldViewingKeys` contains every old viewing key, oldest first, as a tagged
public key and an encrypted 32-byte secret. Each rotation appends the previous
current key and re-encrypts the full vector to the new shared viewing key.
Every current signer, including new members, receives the complete history.
The nullifier key stays unchanged. Record accounts only store these
serialized bytes; nothing on chain parses this structure.

## Transactions

- The vault is the SPP owner signer and fee payer and pays the rent of its
  user registry record and storage pointer, all inside Squads CPIs, so it needs
  SOL. Squads strips the signer flag of its own members inside the CPI, so a
  member cannot pay there.
- Uploads are separate transactions. `prepareKeyRecordUpload` returns
  `upload.transactions`: one that creates the Record account at its full
  size, one `Write` per 768-byte chunk (the last may be shorter), and a final
  `SetAuthority` to the vault in the last one. Each fits a 1,232-byte
  transaction. Its rent payer signs them all; the vault authorizes
  publication. The optional `refund` destination, the payer by default, gets
  the rent back, so a sponsor can pay for uploads and route the rent wherever
  it wants.
- Register sends the user registry `register` and the record's first
  publication in one Squads transaction. Rotate sends `update_keys` and the
  publication of the new record, then the settings change in the same
  transaction. They run under the current signers and threshold. The
  deployed user registry takes only the viewing key in `update_keys`, so the
  client builds that instruction itself.
- Every Squads transaction is sync: `time_lock` is 0, so approvers sign the
  exact transaction that executes. The tests send version 1 transactions
  (4096 bytes). Publication carries the record address and its hash, so the
  whole record need not fit in that transaction.
- `createSmartAccount` returns key record 0, which the creator hands to the
  other signers for Register. It derives the Settings address from the Squads
  account counter, so if another account is created first the create fails
  and is built again.
- Rotate reads kept signers' viewing keys from their user registry records,
  so every kept signer must be registered.
- An approver calls `checkOwnEntry` after the upload and before co-signing
  Register or a rotate. It checks that the upload is frozen under the vault
  and holds exactly the record, so what the approver checked is what gets
  published. It reads the previous record through the vault's pointer
  itself, the same record the publication closes, so a rotator cannot
  substitute one. It verifies every historical ciphertext and checks that the
  new vector preserves all previous keys in order.
- A publication writes the pointer with the next revision and the new
  record's hash, then closes the old record and refunds its balance to that
  upload's destination, or to the vault if the destination has since become
  a program. These changes are atomic. Until the publication runs, the old
  record stays current; once frozen, only the vault can change or close a
  record. The rent payer can cancel an upload with `upload.closeInstruction`
  until its last transaction hands the authority to the vault.
- `recoverVaultKeys` decrypts the current and all old viewing keys directly
  from the latest record. It needs no historical record lookup. The SDK's
  `syncWallet` tries every key on the vault's outputs, so UTXOs sent before
  a member joined are visible too.

`rotateSmartAccount` returns `upload.transactions` and the final
`instructions`. Send each upload transaction in order, have approvers check
the new record and the upload, then send the final instructions together.
`registerVaultInstruction` takes the upload returned by
`prepareKeyRecordUpload` as its `upload` argument.
The replacement carries the entire encrypted key history. Only the current
record stays on chain after a publication; its size is limited to 10 MiB
including the 33-byte Record header. The Record program checks only the
authority; every other check is client-side.

## Run

Install Node.js 24+ and pnpm. Run the SDK commands from `shared-key-storage/sdk`.
Set the Helius RPC URLs in the environment. The SDK uses the same endpoint's
`/v1/spr` for the indexer and attested TEE prover. The tests check the cluster's
genesis hash, deployed programs, Squads configuration, TEE attestation and
proving keys before funding accounts.

```bash
pnpm install
pnpm build                   # emit JavaScript and TypeScript declarations
pnpm test                    # unit tests and LiteSVM storage tests
export SOLANA_DEVNET_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY'
export SOLANA_MAINNET_RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'
pnpm test:devnet             # create, register, spend and rotate on devnet
pnpm test:mainnet            # the same flows on mainnet
```

Only the selected network's RPC variable is required. The payer defaults to
`~/.config/solana/id.json`; set `ZOLANA_PAYER_KEYPAIR` to use another file.
Fund it with at least 0.1 SOL on the selected network. The payer covers fees,
account rent and a 0.01 SOL private deposit. Cleanup returns unused public SOL
from the fresh members and vaults, including after a failed assertion. Current
account rent and the private balances remain on chain; superseded record rent
is refunded to the payer.

The storage tests (`sdk/test/storage.test.ts`) run the SDK's real
instructions in LiteSVM against the SPL Record binary dumped from mainnet
(`sdk/test/fixtures/spl_record.so`). To refresh it:

```bash
solana program dump recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5 sdk/test/fixtures/spl_record.so -u mainnet-beta
```
