# Shared Key Storage examples

Scripts that use the raw storage API of the [SDK](../sdk/), with a record
owned by a Squads smart account ([`smart-account/`](smart-account/)) or a
Swig wallet ([`swig/`](swig/)). Records are stored in accounts of the SPL
Record program; there is no custom program. Your wallet controls the account
and pays the rent.

Each `create` script creates the account and two Record accounts:

- **Record account**: stores the record bytes. The script creates it at full
  size, writes the bytes in 768-byte chunks, one transaction per chunk, and
  then hands its authority to the vault, which freezes the bytes.
- **Pointer account**: a Record account at a seeded address,
  `createWithSeed(vault, "key-record-pointer", Record)`. It stores the
  record's address and the SHA-256 of its bytes. The final transaction,
  signed by the vault through the wallet program, creates it.

Each `rotate` script adds or removes a member and replaces the record in one
transaction: the vault writes the new record's address and hash into the
pointer and closes the old record, whose rent goes to the vault, and the
wallet program changes the member. The Record program rejects the
transaction unless the new record is frozen under the vault and the old
record it closes is still open.

### smart-account

A Squads smart account with your wallet as its only signer, threshold 1. Its
vault owns the record and signs through `executeTransactionSyncV2`; rotate
adds a vote-only signer or removes one with `executeSettingsTransactionSync`.

### swig

A Swig wallet with your wallet as its view key authority, the root role. The
Swig's wallet address owns the record and signs through `SignV2`; rotate adds
a member role, which may only spend through the shielded pool, or removes
one.

## Run

Use Node.js 24+ and pnpm. Build the SDK first, since the examples import its
compiled package. Fund the wallet with SOL on the selected cluster.

```bash
(cd ../sdk && pnpm install && pnpm build)
pnpm install
export SOLANA_RPC_URL='https://devnet.helius-rpc.com/?api-key=YOUR_KEY'
pnpm smart-account-create [file]                                  # smart account and record 0
pnpm smart-account-rotate <settings> add|remove <signer> [file]
pnpm swig-create [file]                                           # Swig and record 0
pnpm swig-rotate <swig> add|remove <member> [file]
```

Without a file argument each script publishes a short sample text. The wallet
defaults to `~/.config/solana/id.json`; set `PAYER_KEYPAIR` to use another
file. The `create` scripts print the address to pass to `rotate`.

There is no close example. A publication closes the record it replaces, and
an upload can be cancelled with `closeInstruction` from `prepareRecordUpload`
until its last transaction hands the authority to the vault.
