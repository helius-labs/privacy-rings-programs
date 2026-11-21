# Private Smart Account (Client)

A Squads smart account holds private balances in the zolana shielded pool (SPP). Every signer can view them through a shared viewing key. Whenever the account is created or its signers change, the signer making the change uploads a key record to an SPL Record account, with that key encrypted to every signer. No program or proof checks the encryption.

## Flows

### 1. Create

1. **Derive.** Each initial signer derives its `ShieldedKeypair` (nullifier key and viewing key) from its Solana keypair.
2. **Assemble signers.** The creator collects the initial signers' viewing public keys, from the user registry or from the signers directly, and picks the threshold.
3. **Encrypt.** The creator generates a random shared viewing keypair and a random nullifier secret. Under one ephemeral key, it encrypts the shared viewing secret to every signer's viewing public key and the nullifier secret to the shared viewing public key.
4. **Create.** The creator submits Squads `createSmartAccount` with no settings authority and `time_lock = 0` and shares the initial key record with the other signers.
5. **Upload and check.** A rent payer uploads the key record in chunks into a fresh Record account and hands its authority to the vault, which freezes the bytes. Each signer checks that the frozen upload holds exactly the record, decrypts its entry and checks that the result belongs to the shared viewing public key.
6. **Register.** A threshold of signers sends Squads `executeTransactionSyncV2` with an inner user registry `register` and the record's first publication, all signed by the vault. These register the vault's keys and create its storage pointer, naming the record and its hash, atomically. Each approver first builds the instruction itself and checks that the one it signs is identical. The vault pays the rent of its registry record and pointer, so it needs SOL.

### 2. Rotate

1. **Assemble signers.** The rotator picks the new signer set and threshold by adding, removing or keeping signers, and collects each added signer's viewing public key. Kept signers' viewing keys come from the user registry, so every kept signer must be registered.
2. **Recover.** The rotator decrypts its entry in the current key record to get the shared viewing secret, then uses that to decrypt the nullifier secret and every old viewing secret in the record.
3. **Encrypt.** The rotator generates a new random shared viewing keypair. Under one new ephemeral key, it encrypts the new shared viewing secret to every viewing public key in the new set. It encrypts the unchanged nullifier secret and all previous viewing secrets, including the current one, to the new shared viewing public key. The old-key vector is ordered oldest first.
4. **Upload and approve.** A rent payer uploads the new key record in chunks and freezes it under the vault. The old record stays current. A threshold of the current Squads signers co-signs the final transaction, which writes the new record's address and hash into the pointer and closes the old record, whose rent goes to the vault. Each approver checks that the frozen upload holds exactly the new record and that its public keys extend the complete history plus current viewing key of the previous record, which it reads from the vault's storage pointer rather than taking from the rotator. An approver that stays a signer also opens its own entry and decrypts and verifies the old viewing keys. Each approver then builds the instructions of step 5 itself, from the record, the upload and the rotation it agrees to (the signers to keep, the signers to add and the threshold), and checks that the ones it signs are identical. The record must name exactly those signers.
5. **Rotate.** The rotator submits one transaction with these instructions, in this order:
   - Squads `executeTransactionSyncV2` with an inner registry `update_keys` setting the new `shared_viewing_pubkey` and the publication of the uploaded record;
   - Squads `executeSettingsTransactionSync` with the add-signer, change-threshold and remove-signer actions.

### 3. Recover

1. **Read.** A current signer reads the vault's storage pointer and the record it names. It accepts the record only if the pointer and the record are Record accounts controlled by the vault and the record's bytes match the pointer's hash.
2. **Check.** The signer checks that the record belongs to its account, that its entry signers equal the account's signers, and that its `shared_viewing_pubkey` equals the vault's registered `viewing_pubkey`.
3. **Decrypt.** The signer decrypts its entry to get the shared viewing secret, then uses that to decrypt the nullifier secret and every old viewing secret. It checks each secret against the public key in the record. Newly added signers recover the same history as the other current signers.

### 4. Remove

1. **Close.** A threshold of signers has the vault close its current record and its storage pointer with the Record program's `CloseAccount`. The rent of both goes to the vault.
2. **After.** The vault has no published record. Its user registry entry stays, with the last shared viewing key and the nullifier key. Create cannot run again for this vault, because `register` fails for a registered vault.

## Using the recovered keys

The recovered keys let a signer view and spend the vault's private balance. The SDK stops at recovery; [`examples/helpers/spend.ts`](examples/helpers/spend.ts) shows the rest:

1. **Sync.** The spender finds the vault's UTXOs by their view tag, which is the vault address, and tries the current and old viewing keys to decrypt them.
2. **Build and prove.** The spender picks the input UTXOs and builds the outputs: each recipient's output goes to the `owner_hash` and viewing public key in that recipient's `UserRecord`, and change goes back to the vault, encrypted to the shared viewing public key. It generates the SPP `transact` proof with the nullifier secret as a private input and the vault as the owner signer.
3. **Approve and send.** The wallet program signs `transact` as the vault. With Squads, a threshold of signers with vote permission co-signs `executeTransactionSyncV2`; together they must hold the initiate, vote and execute permissions.

## Key Record

Key records are opaque bytes in SPL Record accounts; nothing on chain parses or validates KeyRecord, and no custom program is involved. New records are uploaded in chunks into a separate Record account while the current record stays current, then frozen by handing the account's authority to the vault. The vault's pointer, a Record account at `createWithSeed(vault, "key-record-pointer", Record)`, names the current record and the SHA-256 of its bytes. A threshold of signers atomically publishes a new record together with the user-registry update and any Squads settings changes: the publication rewrites the pointer and closes the replaced record, whose rent goes to the vault. All of these changes are atomic. Current signers recover every old viewing key directly from the latest record.

The Record program only enforces that an account's authority writes and closes it. A publication's instructions use that so the Record and System programs reject three cases:

- It sets the new record's authority to the vault, which the record must already have. That changes nothing, but it fails unless the record exists and is frozen under the vault.
- The first publication allocates the pointer, which fails if the vault already has one.
- A later publication closes the record it replaces, which fails if that record is already closed. A publication approved against an older record therefore cannot land.

The rest is client-side. Approvers check the frozen upload's bytes and the exact instructions before signing. Readers accept a record only if the pointer and the record are Record accounts controlled by the vault and the record's bytes match the pointer's hash.

A client checks that the current record's `shared_viewing_pubkey` equals the vault's registered `viewing_pubkey` and its entry signers equal the Squads `Settings.signers`. Approvers check their own encrypted entries before signing. Nothing on chain validates the ciphertexts.

```rust
/// Borsh-serialized key record, stored as the data of an SPL Record account.
pub struct KeyRecord {
    /// The Squads Settings account this record belongs to.
    pub settings: Pubkey,
    /// 0 at create, incremented by every rotate.
    pub epoch: u64,
    /// Tagged X25519 public key of the shared viewing secret.
    pub shared_viewing_pubkey: [u8; 33],
    /// Tagged X25519 public key of the ephemeral secret shared by all ciphertexts.
    pub ephemeral_pubkey: [u8; 33],
    /// Poseidon(nullifier_secret); rotate keeps it unchanged.
    pub nullifier_pubkey: [u8; 32],
    /// AES-256-CTR encryption of the 31-byte nullifier secret to `shared_viewing_pubkey`.
    pub nullifier_ciphertext: [u8; 31],
    /// One entry per Squads signer; the entry signers equal Settings.signers.
    pub entries: Vec<KeyEntry>,
    /// Every old viewing secret encrypted to shared_viewing_pubkey, oldest first.
    pub old_viewing_keys: Vec<EncryptedViewingKey>,
}

pub struct KeyEntry {
    /// The signer's Solana public key, as in Squads Settings.signers.
    pub signer: Pubkey,
    /// The signer's tagged X25519 viewing public key.
    pub viewing_pubkey: [u8; 33],
    /// AES-256-CTR encryption of the 32-byte shared viewing secret to `viewing_pubkey`.
    pub ciphertext: [u8; 32],
}

pub struct EncryptedViewingKey {
    /// Tagged public key used to verify the decrypted old viewing secret.
    pub viewing_pubkey: [u8; 33],
    /// AES-256-CTR encryption of the 32-byte secret to shared_viewing_pubkey.
    pub ciphertext: [u8; 32],
}
```

A key record is `177 + 97 · N + 65 · H` bytes for N signers and H old viewing keys. The client requires H to equal the epoch. Historical key i uses HKDF info `OLD_KEY_INFO || LE32(i)`, distinct from the signer and nullifier domains and from every other old-key index. Decryption checks every secret against its advertised public key. These checks are entirely client-side.

## Swig

A Swig wallet can hold the vault instead of a Squads smart account. Its wallet address is the vault, and the key record is bound to the Swig account. Swig has no threshold: each role acts alone. So the roles split the work by permission, and Swig enforces the split on chain:

- **View key authority**: the root role. Only it can register the vault, publish key records and add or remove members. It always has an entry in the key record, because a rotation must decrypt the current record.
- **Members**: every other role. Each can spend through the shielded pool on its own, but cannot write key records, the user registry or membership.

The flows are the same, with the view key authority in place of a threshold of signers: it creates the Swig and record 0, registers, and rotates by publishing the new record and changing the member roles in one transaction. A spend needs one member's signature.

## Limitations

1. Nothing checks the ciphertexts. Each approver checks only its own entry, so a bad record can lock other signers out.
2. Nothing enforces the rotate flow. Changing the Squads signers without publishing a new record leaves added signers without the key and removed signers with it.
3. Removed signers keep the viewing secrets they received and the nullifier secret, which never rotates.
4. Added signers receive the full key history and can view every earlier balance.
5. Membership is public: the signers are listed in the Squads settings.
6. A signer's new registry viewing key takes effect only at the next rotation.
7. A replaced record's rent goes to the vault, not back to whoever paid for the upload.
8. With Swig, any one member can spend and the view key authority alone controls keys and membership. Losing its key freezes both, since the root role cannot be removed.
