mod common;

use anchor_lang::{
    error::{Error, ErrorCode},
    AccountDeserialize, AccountSerialize,
};
use common::{add_program, program_svm, system_account, SYSTEM};
use mollusk_svm::{
    result::{types::TransactionProgramResult, ProgramResult},
    Mollusk,
};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_program_error::ProgramError;
use solana_sha256_hasher::hashv;
use storage::{
    error::StorageError,
    state::{BufferAccount, PointerAccount, CHUNK_LEN, MAX_RECORD_LEN, POINTER_SEED},
};

/// Instruction tags, pinned here so a tag change fails the tests.
const STORE: u8 = 1;
const APPLY: u8 = 2;
const CLOSE_BUFFER: u8 = 3;
const CREATE_BUFFER: u8 = 4;
const CLOSE_POINTER: u8 = 5;

struct Fixture {
    svm: Mollusk,
    program: Address,
    owner: Address,
    payer: Address,
    /// Refund destination new uploads record; the payer unless a test sets one.
    refund: Address,
    pointer: Address,
    buffer: Address,
    accounts: Vec<(Address, Account)>,
}

impl Fixture {
    fn new() -> Self {
        let program = storage::ID;
        let owner = Address::new_from_array([12; 32]);
        let payer = Address::new_from_array([13; 32]);
        let buffer = Address::new_from_array([14; 32]);
        let (pointer, _) = Address::find_program_address(&[POINTER_SEED, owner.as_ref()], &program);
        let svm = program_svm();
        let accounts = vec![
            (owner, system_account(1_000_000)),
            (payer, system_account(1_000_000_000)),
            (pointer, system_account(0)),
            (buffer, system_account(0)),
            mollusk_svm::program::keyed_account_for_system_program(),
        ];
        Self {
            svm,
            program,
            owner,
            payer,
            refund: payer,
            pointer,
            buffer,
            accounts,
        }
    }

    fn account(&self, address: Address) -> &Account {
        &self
            .accounts
            .iter()
            .find(|(key, _)| *key == address)
            .expect("fixture account")
            .1
    }

    fn account_mut(&mut self, address: Address) -> &mut Account {
        &mut self
            .accounts
            .iter_mut()
            .find(|(key, _)| *key == address)
            .expect("fixture account")
            .1
    }

    /// A funded system account the tests can use as another signer.
    fn add_wallet(&mut self) -> Address {
        let wallet = Address::new_unique();
        self.accounts.push((wallet, system_account(1_000_000_000)));
        wallet
    }

    /// `create_buffer` while the buffer does not exist yet, `store` after.
    fn store(&self, previous: Address, total: u32, offset: u32, chunk: &[u8]) -> Instruction {
        let tag = if self.account(self.buffer).owner == self.program {
            STORE
        } else {
            CREATE_BUFFER
        };
        let mut instruction_data = vec![tag];
        instruction_data.extend_from_slice(self.owner.as_ref());
        instruction_data.extend_from_slice(previous.as_ref());
        instruction_data.extend_from_slice(&total.to_le_bytes());
        instruction_data.extend_from_slice(&offset.to_le_bytes());
        instruction_data.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
        instruction_data.extend_from_slice(chunk);
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(self.buffer, true),
                AccountMeta::new(self.payer, true),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(self.refund, false),
            ],
            data: instruction_data,
        }
    }

    /// Apply of the current buffer; the predecessor's recorded destination gets the refund.
    fn apply(&self, data_hash: [u8; 32]) -> Instruction {
        let previous = self.header().previous;
        let revision = if self.account(self.pointer).data.is_empty() {
            0
        } else {
            self.pointer_state().revision
        };
        let mut instruction_data = vec![APPLY];
        instruction_data.extend_from_slice(previous.as_ref());
        instruction_data.extend_from_slice(&revision.to_le_bytes());
        instruction_data.extend_from_slice(&data_hash);
        // The first publication has no predecessor: Anchor reads the program
        // id in an optional account slot as `None`.
        let (previous_meta, refund_meta) = if previous == SYSTEM {
            (
                AccountMeta::new_readonly(self.program, false),
                AccountMeta::new_readonly(self.program, false),
            )
        } else {
            let refund = self.buffer_at(previous).refund;
            (
                AccountMeta::new(previous, false),
                AccountMeta::new(refund, false),
            )
        };
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(self.pointer, false),
                AccountMeta::new(self.buffer, false),
                AccountMeta::new_readonly(self.owner, true),
                AccountMeta::new(self.payer, true),
                AccountMeta::new_readonly(SYSTEM, false),
                previous_meta,
                refund_meta,
            ],
            data: instruction_data,
        }
    }

    /// Cancel of the current buffer, refunding its recorded destination.
    fn close(&self) -> Instruction {
        let refund = BufferAccount::try_deserialize(&mut self.account(self.buffer).data.as_slice())
            .map_or(self.refund, |header| header.refund);
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(self.buffer, false),
                AccountMeta::new_readonly(self.payer, true),
                AccountMeta::new(refund, false),
            ],
            data: vec![CLOSE_BUFFER],
        }
    }

    /// Close of the owner's pointer and its current record; `recipient` gets
    /// the pointer's rent.
    fn close_pointer(&self, recipient: Address) -> Instruction {
        let record = self.pointer_state().current;
        let refund = self.buffer_at(record).refund;
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(self.pointer, false),
                AccountMeta::new(record, false),
                AccountMeta::new_readonly(self.owner, true),
                AccountMeta::new(recipient, false),
                AccountMeta::new(refund, false),
            ],
            data: vec![CLOSE_POINTER],
        }
    }

    fn succeed(&mut self, instruction: Instruction) {
        let execution = self.svm.process_instruction(&instruction, &self.accounts);
        assert_eq!(execution.program_result, ProgramResult::Success);
        self.accounts = execution.resulting_accounts;
    }

    fn reject(&self, instruction: Instruction, error: ProgramError) {
        self.reject_with(instruction, ProgramResult::Failure(error));
    }

    /// Like `reject`, for failures the runtime raises before or around the
    /// program, such as a CPI that needs a missing signature or writability.
    fn reject_with(&self, instruction: Instruction, result: ProgramResult) {
        let execution = self.svm.process_instruction(&instruction, &self.accounts);
        assert_eq!(
            (execution.program_result, execution.resulting_accounts),
            (result, self.accounts.clone()),
            "failure must return the exact error and preserve every account",
        );
    }

    fn upload(&mut self, previous: Address, bytes: &[u8]) -> [u8; 32] {
        let mut data_hash = [0; 32];
        for (chunk_index, chunk) in bytes.chunks(CHUNK_LEN).enumerate() {
            let offset = chunk_index * CHUNK_LEN;
            self.succeed(self.store(previous, bytes.len() as u32, offset as u32, chunk));
            data_hash = hashv(&[&data_hash, chunk]).to_bytes();
        }
        data_hash
    }

    fn next_buffer(&mut self) -> Address {
        let previous = self.buffer;
        self.buffer = Address::new_unique();
        self.accounts.push((self.buffer, system_account(0)));
        previous
    }

    fn header(&self) -> BufferAccount {
        self.buffer_at(self.buffer)
    }

    fn buffer_at(&self, address: Address) -> BufferAccount {
        BufferAccount::try_deserialize(&mut self.account(address).data.as_slice())
            .expect("buffer account")
    }

    fn pointer_state(&self) -> PointerAccount {
        PointerAccount::try_deserialize(&mut self.account(self.pointer).data.as_slice()).unwrap()
    }
}

fn custom(error: StorageError) -> ProgramError {
    Error::from(error).into()
}

fn anchor(error: ErrorCode) -> ProgramError {
    Error::from(error).into()
}

/// Overwrites the start of `data` with `account`'s discriminator and fields.
fn write_state(account: &impl AccountSerialize, mut data: &mut [u8]) {
    account.try_serialize(&mut data).unwrap();
}

/// A full first chunk followed by room for one more byte.
const SPLIT_TOTAL: u32 = CHUNK_LEN as u32 + 1;

#[test]
fn chunked_growth_preserves_the_active_record_until_atomic_replacement() {
    let mut fixture = Fixture::new();
    let first_bytes = b"first key record";
    let first_hash = fixture.upload(SYSTEM, first_bytes);
    fixture.succeed(fixture.apply(first_hash));
    let first_address = fixture.next_buffer();
    let first_account = fixture.account(first_address).clone();
    let previous_pointer = fixture.account(fixture.pointer).clone();
    let next_bytes = vec![37; 25_000];
    let next_hash = fixture.upload(first_address, &next_bytes);
    assert_eq!(
        next_hash,
        [
            60, 63, 233, 166, 40, 232, 53, 162, 105, 22, 148, 226, 163, 204, 248, 247, 228, 44, 16,
            79, 233, 154, 144, 214, 76, 29, 225, 11, 79, 248, 224, 62
        ]
    );
    assert_eq!(
        (
            fixture.account(first_address),
            fixture.account(fixture.pointer)
        ),
        (&first_account, &previous_pointer),
        "uploads must not change the published record or pointer",
    );
    let pending_header = fixture.header();
    assert_eq!(
        pending_header,
        BufferAccount {
            sealed: false,
            owner: fixture.owner,
            payer: fixture.payer,
            refund: fixture.payer,
            previous: first_address,
            total_length: next_bytes.len() as u32,
            data_hash: next_hash,
        },
    );
    let payer_balance = fixture.account(fixture.payer).lamports;
    fixture.succeed(fixture.apply(next_hash));
    // Closing hands the account back to the System Program with no lamports or data.
    let closed_first = system_account(0);
    assert_eq!(
        (
            fixture.pointer_state(),
            fixture.header(),
            fixture
                .account(fixture.buffer)
                .data
                .get(BufferAccount::LEN..)
                .unwrap(),
            fixture.account(first_address),
            fixture.account(fixture.payer).lamports,
        ),
        (
            PointerAccount {
                current: fixture.buffer,
                revision: 2,
            },
            BufferAccount {
                sealed: true,
                ..pending_header
            },
            next_bytes.as_slice(),
            &closed_first,
            payer_balance + first_account.lamports,
        ),
        "publication must seal the replacement and close only its predecessor",
    );
    assert_eq!(
        fixture.account(fixture.pointer).data.len(),
        PointerAccount::LEN
    );
}

#[test]
fn prefunded_buffer_and_pointer_cannot_block_initialization() {
    let mut fixture = Fixture::new();
    fixture.account_mut(fixture.buffer).lamports = 1_000_000;
    fixture.account_mut(fixture.pointer).lamports = 1_000_000;
    let data_hash = fixture.upload(SYSTEM, b"record");
    fixture.succeed(fixture.apply(data_hash));
    assert!(fixture.header().sealed);
}

#[test]
fn the_vault_pays_pointer_rent_and_the_uploader_gets_the_refund() {
    let mut fixture = Fixture::new();
    fixture.account_mut(fixture.owner).lamports = 20_000_000;
    let data_hash = fixture.upload(SYSTEM, b"record");
    let mut instruction = fixture.apply(data_hash);
    instruction.accounts.get_mut(3).unwrap().pubkey = fixture.owner;
    fixture.succeed(instruction);
    assert!(fixture.header().sealed);
    let first = fixture.next_buffer();
    let next_hash = fixture.upload(first, b"replacement");
    let owner_balance = fixture.account(fixture.owner).lamports;
    let payer_balance = fixture.account(fixture.payer).lamports;
    let predecessor_balance = fixture.account(first).lamports;
    let mut instruction = fixture.apply(next_hash);
    instruction.accounts.get_mut(3).unwrap().pubkey = fixture.owner;
    fixture.succeed(instruction);
    assert_eq!(
        (
            fixture.account(fixture.owner).lamports,
            fixture.account(fixture.payer).lamports,
            fixture.account(first).lamports
        ),
        (owner_balance, payer_balance + predecessor_balance, 0),
        "the predecessor's uploader receives its rent, not the apply payer",
    );
}

#[test]
fn repeated_or_skipped_offsets_fail() {
    let mut fixture = Fixture::new();
    fixture.succeed(fixture.store(SYSTEM, SPLIT_TOTAL, 0, &[1; CHUNK_LEN]));
    for offset in [0, CHUNK_LEN as u32 - 1, CHUNK_LEN as u32 + 1, u32::MAX] {
        fixture.reject(
            fixture.store(SYSTEM, SPLIT_TOTAL, offset, b"d"),
            custom(StorageError::InvalidOffset),
        );
    }
}

#[test]
fn upload_metadata_cannot_be_changed() {
    let mut fixture = Fixture::new();
    let offset = CHUNK_LEN as u32;
    fixture.succeed(fixture.store(SYSTEM, SPLIT_TOTAL, 0, &[1; CHUNK_LEN]));
    fixture.reject(
        fixture.store(SYSTEM, SPLIT_TOTAL + 1, offset, b"d"),
        custom(StorageError::MetadataMismatch),
    );
    fixture.reject(
        fixture.store(Address::new_unique(), SPLIT_TOTAL, offset, b"d"),
        custom(StorageError::MetadataMismatch),
    );
    let mut instruction = fixture.store(SYSTEM, SPLIT_TOTAL, offset, b"d");
    instruction.data.get_mut(1..33).unwrap().fill(99);
    fixture.reject(instruction, custom(StorageError::MetadataMismatch));
}

#[test]
fn every_chunk_of_an_upload_has_the_same_payer() {
    let mut fixture = Fixture::new();
    fixture.succeed(fixture.store(SYSTEM, SPLIT_TOTAL, 0, &[1; CHUNK_LEN]));
    let other = fixture.add_wallet();
    let mut instruction = fixture.store(SYSTEM, SPLIT_TOTAL, CHUNK_LEN as u32, b"d");
    instruction.accounts.get_mut(1).unwrap().pubkey = other;
    fixture.reject(instruction, custom(StorageError::PayerMismatch));
}

#[test]
fn invalid_lengths_fail_before_mutating_accounts() {
    let fixture = Fixture::new();
    for (total, chunk) in [
        (0, vec![1]),
        (MAX_RECORD_LEN as u32 + 1, vec![1]),
        (1, vec![]),
        (1, vec![1, 2]),
        (2 * SPLIT_TOTAL, vec![1; CHUNK_LEN + 1]),
        // Only the final chunk may be shorter than CHUNK_LEN.
        (SPLIT_TOTAL, vec![1; CHUNK_LEN - 1]),
    ] {
        fixture.reject(
            fixture.store(SYSTEM, total, 0, &chunk),
            custom(StorageError::InvalidLength),
        );
    }
}

#[test]
fn store_requires_buffer_and_payer_signatures() {
    let mut fixture = Fixture::new();
    // create_buffer: the System Program needs the new buffer's signature.
    for (signer_index, result) in [
        (
            0,
            ProgramResult::UnknownError(InstructionError::PrivilegeEscalation),
        ),
        (
            1,
            ProgramResult::Failure(anchor(ErrorCode::AccountNotSigner)),
        ),
    ] {
        let mut instruction = fixture.store(SYSTEM, SPLIT_TOTAL, 0, &[1; CHUNK_LEN]);
        instruction
            .accounts
            .get_mut(signer_index)
            .unwrap()
            .is_signer = false;
        fixture.reject_with(instruction, result);
    }
    // store: both still sign every later chunk.
    fixture.succeed(fixture.store(SYSTEM, SPLIT_TOTAL, 0, &[1; CHUNK_LEN]));
    for (signer_index, error) in [
        (0, ErrorCode::ConstraintSigner),
        (1, ErrorCode::AccountNotSigner),
    ] {
        let mut instruction = fixture.store(SYSTEM, SPLIT_TOTAL, CHUNK_LEN as u32, b"d");
        instruction
            .accounts
            .get_mut(signer_index)
            .unwrap()
            .is_signer = false;
        fixture.reject(instruction, anchor(error));
    }
}

#[test]
fn readonly_buffers_are_rejected() {
    let fixture = Fixture::new();
    let mut instruction = fixture.store(SYSTEM, 3, 0, b"abc");
    instruction.accounts.first_mut().unwrap().is_writable = false;
    fixture.reject_with(
        instruction,
        ProgramResult::UnknownError(InstructionError::PrivilegeEscalation),
    );
}

#[test]
fn foreign_buffer_owners_and_discriminators_are_rejected() {
    let mut fixture = Fixture::new();
    // create_buffer: the System Program refuses an account it does not own
    // (SystemError::AccountAlreadyInUse).
    fixture.account_mut(fixture.buffer).owner = Address::new_unique();
    fixture.reject(fixture.store(SYSTEM, 3, 0, b"abc"), ProgramError::Custom(0));
    // store: a program-owned account without the buffer discriminator.
    fixture.account_mut(fixture.buffer).owner = fixture.program;
    fixture.account_mut(fixture.buffer).data = vec![0; BufferAccount::LEN];
    fixture.reject(
        fixture.store(SYSTEM, 3, 0, b"abc"),
        anchor(ErrorCode::AccountDiscriminatorMismatch),
    );
}

#[test]
fn incomplete_buffers_cannot_be_applied() {
    let mut fixture = Fixture::new();
    fixture.succeed(fixture.store(SYSTEM, SPLIT_TOTAL, 0, &[1; CHUNK_LEN]));
    fixture.reject(
        fixture.apply(fixture.header().data_hash),
        custom(StorageError::InvalidLength),
    );
}

#[test]
fn the_approved_hash_must_match_the_uploaded_bytes() {
    let mut fixture = Fixture::new();
    fixture.upload(SYSTEM, b"abc");
    fixture.reject(fixture.apply([99; 32]), custom(StorageError::HashMismatch));
}

#[test]
fn apply_requires_the_owners_signature() {
    let mut fixture = Fixture::new();
    let data_hash = fixture.upload(SYSTEM, b"abc");
    let mut instruction = fixture.apply(data_hash);
    instruction.accounts.get_mut(2).unwrap().is_signer = false;
    fixture.reject(instruction, anchor(ErrorCode::AccountNotSigner));
}

#[test]
fn a_buffer_for_another_owner_cannot_be_published() {
    let mut fixture = Fixture::new();
    let mut instruction = fixture.store(SYSTEM, 3, 0, b"abc");
    instruction.data.get_mut(1..33).unwrap().fill(98);
    fixture.succeed(instruction);
    fixture.reject(
        fixture.apply(fixture.header().data_hash),
        anchor(ErrorCode::ConstraintHasOne),
    );
}

#[test]
fn the_pointer_must_be_the_owners_canonical_pda() {
    let mut fixture = Fixture::new();
    let data_hash = fixture.upload(SYSTEM, b"abc");
    let alternate = Address::new_unique();
    fixture.accounts.push((alternate, system_account(0)));
    let mut instruction = fixture.apply(data_hash);
    instruction.accounts.first_mut().unwrap().pubkey = alternate;
    fixture.reject(instruction, anchor(ErrorCode::ConstraintSeeds));
}

#[test]
fn the_first_publication_has_no_predecessor() {
    let mut fixture = Fixture::new();
    let data_hash = fixture.upload(SYSTEM, b"abc");
    let other = fixture.add_wallet();
    let mut instruction = fixture.apply(data_hash);
    *instruction.accounts.get_mut(6).unwrap() = AccountMeta::new(other, false);
    fixture.reject(instruction, custom(StorageError::InvalidFirstPublication));
}

#[test]
fn stale_uploads_cannot_replace_a_newer_pointer() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    let first = fixture.next_buffer();
    let stale_hash = fixture.upload(SYSTEM, b"competing");
    let stale = fixture.buffer;
    fixture.buffer = first;
    fixture.succeed(fixture.apply(first_hash));
    fixture.buffer = stale;
    fixture.reject(fixture.apply(stale_hash), custom(StorageError::StaleHead));
}

#[test]
fn the_active_record_cannot_be_appended_reapplied_or_separately_closed() {
    let mut fixture = Fixture::new();
    let data_hash = fixture.upload(SYSTEM, b"abc");
    fixture.succeed(fixture.apply(data_hash));
    for instruction in [
        fixture.store(SYSTEM, 3, 3, b"x"),
        fixture.apply(data_hash),
        fixture.close(),
    ] {
        fixture.reject(instruction, custom(StorageError::Sealed));
    }
}

#[test]
fn recreating_a_cancelled_buffer_cannot_reuse_an_old_approval() {
    let mut fixture = Fixture::new();
    let approved_hash = fixture.upload(SYSTEM, b"approved record");
    let old_approval = fixture.apply(approved_hash);
    let cancelled = fixture.buffer;
    fixture.succeed(fixture.close());
    fixture.next_buffer();
    let intervening_hash = fixture.upload(SYSTEM, b"intervening record");
    fixture.succeed(fixture.apply(intervening_hash));
    let intervening = fixture.buffer;
    // A zero-lamport account is purged between transactions by the cluster.
    *fixture.account_mut(cancelled) = system_account(0);
    fixture.buffer = cancelled;
    assert_eq!(
        fixture.upload(intervening, b"approved record"),
        approved_hash
    );
    fixture.reject(old_approval, custom(StorageError::StaleHead));
}

#[test]
fn reusing_a_superseded_address_cannot_revive_a_stale_approval() {
    let mut fixture = Fixture::new();
    let original_hash = fixture.upload(SYSTEM, b"original");
    fixture.succeed(fixture.apply(original_hash));
    let original = fixture.next_buffer();
    let stale_hash = fixture.upload(original, b"stale update");
    let stale_approval = fixture.apply(stale_hash);
    let stale = fixture.buffer;
    fixture.next_buffer();
    let intervening_hash = fixture.upload(original, b"intervening");
    fixture.succeed(fixture.apply(intervening_hash));
    let intervening = fixture.buffer;
    assert_eq!(fixture.account(original).lamports, 0);
    // Simulate the cluster purging the closed account between transactions.
    *fixture.account_mut(original) = system_account(0);
    fixture.buffer = original;
    assert_eq!(fixture.upload(intervening, b"original"), original_hash);
    fixture.succeed(fixture.apply(original_hash));
    assert_eq!(fixture.pointer_state().revision, 3);
    fixture.buffer = stale;
    fixture.reject(stale_approval, custom(StorageError::StaleHead));
    fixture.succeed(fixture.apply(stale_hash));
}

#[test]
fn replacement_requires_the_exact_writable_predecessor() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    let next_hash = fixture.upload(first, b"next");
    let mut substituted = fixture.apply(next_hash);
    substituted.accounts.get_mut(5).unwrap().pubkey = fixture.owner;
    fixture.reject(substituted, anchor(ErrorCode::AccountOwnedByWrongProgram));
    let mut readonly = fixture.apply(next_hash);
    readonly.accounts.get_mut(5).unwrap().is_writable = false;
    fixture.reject(readonly, anchor(ErrorCode::ConstraintMut));
}

#[test]
fn replacement_refunds_only_the_predecessors_destination() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    let next_hash = fixture.upload(first, b"next");
    let other = fixture.add_wallet();
    let mut redirected = fixture.apply(next_hash);
    redirected.accounts.get_mut(6).unwrap().pubkey = other;
    fixture.reject(redirected, custom(StorageError::RefundMismatch));
    // The vault pays apply, so the uploader appears only as the refund account.
    let mut readonly = fixture.apply(next_hash);
    readonly.accounts.get_mut(3).unwrap().pubkey = fixture.owner;
    readonly.accounts.get_mut(6).unwrap().is_writable = false;
    fixture.reject(readonly, custom(StorageError::NotWritable));
}

#[test]
fn replacement_rejects_a_foreign_or_unsealed_predecessor() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    let next_hash = fixture.upload(first, b"next");
    let original = fixture.account(first).clone();
    fixture.account_mut(first).owner = fixture.owner;
    fixture.reject(
        fixture.apply(next_hash),
        anchor(ErrorCode::AccountOwnedByWrongProgram),
    );
    *fixture.account_mut(first) = original.clone();
    let mut header = fixture.buffer_at(first);
    header.owner = Address::new_from_array([99; 32]);
    write_state(&header, &mut fixture.account_mut(first).data);
    fixture.reject(
        fixture.apply(next_hash),
        custom(StorageError::InvalidPredecessor),
    );
    *fixture.account_mut(first) = original;
    let mut header = fixture.buffer_at(first);
    header.sealed = false;
    write_state(&header, &mut fixture.account_mut(first).data);
    fixture.reject(
        fixture.apply(next_hash),
        custom(StorageError::InvalidPredecessor),
    );
}

#[test]
fn revision_overflow_cannot_close_the_active_record() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    let next_hash = fixture.upload(first, b"next");
    write_state(
        &PointerAccount {
            current: first,
            revision: u64::MAX,
        },
        &mut fixture.account_mut(fixture.pointer).data,
    );
    fixture.reject(fixture.apply(next_hash), ProgramError::ArithmeticOverflow);
}

#[test]
fn refund_overflow_rolls_back_publication_and_closure() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    let next_hash = fixture.upload(first, b"next");
    fixture.account_mut(fixture.payer).lamports = u64::MAX;
    fixture.reject(fixture.apply(next_hash), ProgramError::ArithmeticOverflow);
}

#[test]
fn closing_an_unpublished_buffer_refunds_its_full_rent() {
    let mut fixture = Fixture::new();
    fixture.upload(SYSTEM, b"abc");
    let total_lamports =
        fixture.account(fixture.payer).lamports + fixture.account(fixture.buffer).lamports;
    fixture.succeed(fixture.close());
    assert_eq!(
        (
            fixture.account(fixture.buffer).lamports,
            fixture.account(fixture.buffer).data.as_slice(),
            fixture.account(fixture.payer).lamports
        ),
        (0, &[][..], total_lamports),
    );
}

#[test]
fn only_the_recorded_payer_can_cancel_an_upload() {
    let mut fixture = Fixture::new();
    fixture.upload(SYSTEM, b"abc");
    let mut unsigned = fixture.close();
    unsigned.accounts.get_mut(1).unwrap().is_signer = false;
    fixture.reject(unsigned, anchor(ErrorCode::AccountNotSigner));
    let other = fixture.add_wallet();
    let mut stranger = fixture.close();
    stranger.accounts.get_mut(1).unwrap().pubkey = other;
    fixture.reject(stranger, custom(StorageError::PayerMismatch));
    let mut redirected = fixture.close();
    redirected.accounts.get_mut(2).unwrap().pubkey = other;
    fixture.reject(redirected, custom(StorageError::RefundMismatch));
    let mut aliased = fixture.close();
    aliased.accounts.get_mut(2).unwrap().pubkey = fixture.buffer;
    fixture.reject(aliased, custom(StorageError::RefundMismatch));
}

#[test]
fn a_chosen_destination_receives_the_cancel_and_replacement_refunds() {
    let mut fixture = Fixture::new();
    let destination = fixture.add_wallet();
    fixture.refund = destination;
    fixture.upload(SYSTEM, b"cancelled");
    let destination_balance = fixture.account(destination).lamports;
    let buffer_balance = fixture.account(fixture.buffer).lamports;
    fixture.succeed(fixture.close());
    assert_eq!(
        fixture.account(destination).lamports,
        destination_balance + buffer_balance,
        "cancelling refunds the destination, not the payer",
    );
    fixture.next_buffer();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    fixture.refund = fixture.payer;
    let next_hash = fixture.upload(first, b"next");
    let destination_balance = fixture.account(destination).lamports;
    let payer_balance = fixture.account(fixture.payer).lamports;
    let first_balance = fixture.account(first).lamports;
    fixture.succeed(fixture.apply(next_hash));
    assert_eq!(
        (
            fixture.account(destination).lamports,
            fixture.account(fixture.payer).lamports,
        ),
        (destination_balance + first_balance, payer_balance),
        "replacing a record refunds the destination it recorded",
    );
}

#[test]
fn the_destination_is_fixed_at_the_first_chunk() {
    let mut fixture = Fixture::new();
    fixture.succeed(fixture.store(SYSTEM, SPLIT_TOTAL, 0, &[1; CHUNK_LEN]));
    fixture.refund = fixture.add_wallet();
    fixture.reject(
        fixture.store(SYSTEM, SPLIT_TOTAL, CHUNK_LEN as u32, b"d"),
        custom(StorageError::MetadataMismatch),
    );
}

#[test]
fn the_destination_must_be_a_plain_system_account_other_than_the_buffer() {
    let mut fixture = Fixture::new();
    let owned = fixture.add_wallet();
    fixture.account_mut(owned).owner = fixture.program;
    let executable = fixture.add_wallet();
    fixture.account_mut(executable).executable = true;
    for (destination, error) in [
        (owned, custom(StorageError::InvalidRefundDestination)),
        (executable, custom(StorageError::InvalidRefundDestination)),
        (
            fixture.buffer,
            custom(StorageError::InvalidRefundDestination),
        ),
    ] {
        fixture.refund = destination;
        fixture.reject(fixture.store(SYSTEM, 3, 0, b"abc"), error);
    }
}

#[test]
fn a_record_cannot_name_its_owners_pointer_as_destination() {
    let mut fixture = Fixture::new();
    fixture.refund = fixture.pointer;
    let data_hash = fixture.upload(SYSTEM, b"abc");
    fixture.reject(
        fixture.apply(data_hash),
        custom(StorageError::RefundIsPointer),
    );
}

#[test]
fn an_executable_destination_refunds_the_apply_payer_instead() {
    let mut fixture = Fixture::new();
    let destination = fixture.add_wallet();
    fixture.refund = destination;
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    fixture.refund = fixture.payer;
    let next_hash = fixture.upload(first, b"next");
    // The destination's owner later deploys a program at that address.
    fixture.account_mut(destination).executable = true;
    let destination_balance = fixture.account(destination).lamports;
    let payer_balance = fixture.account(fixture.payer).lamports;
    let first_balance = fixture.account(first).lamports;
    let mut instruction = fixture.apply(next_hash);
    instruction.accounts.get_mut(6).unwrap().is_writable = false;
    fixture.succeed(instruction);
    assert_eq!(
        (
            fixture.account(destination).lamports,
            fixture.account(fixture.payer).lamports,
        ),
        (destination_balance, payer_balance + first_balance),
        "the record stays replaceable and its rent goes to the apply payer",
    );
}

#[test]
fn wrong_system_program_and_aliased_payer_are_rejected() {
    let fixture = Fixture::new();
    let mut wrong_program = fixture.store(SYSTEM, 3, 0, b"abc");
    wrong_program.accounts.get_mut(2).unwrap().pubkey = fixture.owner;
    fixture.reject(wrong_program, anchor(ErrorCode::InvalidProgramId));
    let mut aliased = fixture.store(SYSTEM, 3, 0, b"abc");
    aliased.accounts.get_mut(1).unwrap().pubkey = fixture.buffer;
    fixture.reject(aliased, ProgramError::InvalidArgument);
}

#[test]
fn malformed_instructions_fail_without_account_changes() {
    let fixture = Fixture::new();
    for (instruction_data, error) in [
        (vec![], ErrorCode::InstructionFallbackNotFound),
        (vec![0], ErrorCode::InstructionFallbackNotFound),
        (vec![255], ErrorCode::InstructionFallbackNotFound),
        (vec![STORE], ErrorCode::InstructionDidNotDeserialize),
        (vec![APPLY], ErrorCode::InstructionDidNotDeserialize),
        // Anchor ignores bytes after the data; the missing accounts fail instead.
        (vec![CLOSE_BUFFER, 0], ErrorCode::AccountNotEnoughKeys),
    ] {
        fixture.reject(
            Instruction {
                program_id: fixture.program,
                accounts: vec![],
                data: instruction_data,
            },
            anchor(error),
        );
    }
}

#[test]
fn the_binary_only_runs_at_its_declared_address() {
    let mut fixture = Fixture::new();
    let elsewhere = Address::new_unique();
    add_program(&mut fixture.svm, &elsewhere);
    let mut instruction = fixture.store(SYSTEM, 3, 0, b"abc");
    instruction.program_id = elsewhere;
    fixture.reject(instruction, anchor(ErrorCode::DeclaredProgramIdMismatch));
}

#[test]
fn apply_rolls_back_if_a_later_instruction_fails() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    let next_hash = fixture.upload(first, b"next");
    let before = fixture.accounts.clone();
    let execution = fixture.svm.process_transaction_instructions(
        &[
            fixture.apply(next_hash),
            Instruction {
                program_id: fixture.program,
                accounts: vec![],
                data: vec![255],
            },
        ],
        &fixture.accounts,
        None,
    );
    assert_eq!(
        execution.program_result,
        TransactionProgramResult::Failure(1, anchor(ErrorCode::InstructionFallbackNotFound))
    );
    assert_eq!(
        execution.resulting_accounts, before,
        "both publication and sealing must roll back"
    );
    fixture.succeed(fixture.apply(next_hash));
    assert!(fixture.header().sealed);
}

#[test]
fn close_pointer_closes_the_pointer_and_its_current_record() {
    let mut fixture = Fixture::new();
    let destination = fixture.add_wallet();
    fixture.refund = destination;
    let data_hash = fixture.upload(SYSTEM, b"record");
    fixture.succeed(fixture.apply(data_hash));
    let recipient = fixture.add_wallet();
    let record = fixture.buffer;
    let balances = (
        fixture.account(fixture.pointer).lamports,
        fixture.account(record).lamports,
        fixture.account(recipient).lamports,
        fixture.account(destination).lamports,
    );
    fixture.succeed(fixture.close_pointer(recipient));
    assert_eq!(
        (
            fixture.account(fixture.pointer),
            fixture.account(record),
            fixture.account(recipient).lamports,
            fixture.account(destination).lamports,
        ),
        (
            &system_account(0),
            &system_account(0),
            balances.2 + balances.0,
            balances.3 + balances.1,
        ),
        "the pointer's rent goes to the recipient, the record's to its destination",
    );
}

#[test]
fn close_pointer_requires_the_owners_signature() {
    let mut fixture = Fixture::new();
    let data_hash = fixture.upload(SYSTEM, b"record");
    fixture.succeed(fixture.apply(data_hash));
    let recipient = fixture.add_wallet();
    let mut instruction = fixture.close_pointer(recipient);
    instruction.accounts.get_mut(2).unwrap().is_signer = false;
    fixture.reject(instruction, anchor(ErrorCode::AccountNotSigner));
}

#[test]
fn close_pointer_closes_only_the_current_record() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let first = fixture.next_buffer();
    fixture.upload(first, b"pending");
    let recipient = fixture.add_wallet();
    let mut instruction = fixture.close_pointer(recipient);
    // Name the unpublished upload instead of the published record.
    instruction.accounts.get_mut(1).unwrap().pubkey = fixture.buffer;
    fixture.reject(instruction, custom(StorageError::InvalidPredecessor));
}

#[test]
fn an_owner_can_publish_again_after_closing_the_pointer() {
    let mut fixture = Fixture::new();
    let first_hash = fixture.upload(SYSTEM, b"first");
    fixture.succeed(fixture.apply(first_hash));
    let recipient = fixture.add_wallet();
    fixture.succeed(fixture.close_pointer(recipient));
    // The revision restarts: the next publication is a first publication again.
    fixture.next_buffer();
    let next_hash = fixture.upload(SYSTEM, b"next");
    fixture.succeed(fixture.apply(next_hash));
    assert_eq!(
        fixture.pointer_state(),
        PointerAccount {
            current: fixture.buffer,
            revision: 1,
        }
    );
}
