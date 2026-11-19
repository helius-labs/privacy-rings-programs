//! Compatibility with the deployed program: account layouts must match it
//! exactly, and the instruction tags keep their meaning. Every expected byte
//! string here is built by hand from the documented format, independently of
//! the types under test.

mod common;

use anchor_lang::{error::Error, AccountDeserialize, AccountSerialize, InstructionData};
use common::{funded, program_svm, system_account, SYSTEM};
use mollusk_svm::result::ProgramResult;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_sha256_hasher::hashv;
use storage::{
    error::StorageError,
    instruction,
    state::{BufferAccount, PointerAccount, POINTER_SEED},
    ApplyInstructionData, StoreInstructionData,
};

fn address(byte: u8) -> Address {
    Address::new_from_array([byte; 32])
}

/// The buffer header exactly as the deployed program writes it.
fn deployed_buffer_header(sealed: u8, total_length: u32) -> Vec<u8> {
    let mut bytes = b"STORBUF1".to_vec();
    bytes.push(sealed);
    for byte in [1, 2, 3, 4] {
        bytes.extend_from_slice(&[byte; 32]);
    }
    bytes.extend_from_slice(&total_length.to_le_bytes());
    bytes.extend_from_slice(&[5; 32]);
    bytes
}

/// The pointer (deployed "head") exactly as the deployed program writes it.
fn deployed_pointer(current: Address, revision: u64) -> Vec<u8> {
    let mut bytes = b"STORHEAD".to_vec();
    bytes.extend_from_slice(current.as_ref());
    bytes.extend_from_slice(&revision.to_le_bytes());
    bytes
}

fn serialized(account: &impl AccountSerialize) -> Vec<u8> {
    let mut bytes = Vec::new();
    account.try_serialize(&mut bytes).unwrap();
    bytes
}

#[test]
fn the_original_error_codes_are_kept() {
    let errors = [
        StorageError::Sealed,
        StorageError::InvalidOffset,
        StorageError::InvalidLength,
        StorageError::HashMismatch,
        StorageError::StaleHead,
        StorageError::MetadataMismatch,
        StorageError::PayerMismatch,
        StorageError::RefundMismatch,
    ];
    let codes: Vec<ProgramError> = errors
        .into_iter()
        .map(|error| ProgramError::from(Error::from(error)))
        .collect();
    assert_eq!(
        codes,
        (7000..=7007).map(ProgramError::Custom).collect::<Vec<_>>()
    );
}

#[test]
fn buffer_account_round_trips_the_deployed_layout() {
    let mut bytes = deployed_buffer_header(1, 3);
    bytes.extend_from_slice(b"abc");
    let buffer = BufferAccount::try_deserialize(&mut bytes.as_slice()).unwrap();
    assert_eq!(
        buffer,
        BufferAccount {
            sealed: true,
            owner: address(1),
            payer: address(2),
            refund: address(3),
            previous: address(4),
            total_length: 3,
            data_hash: [5; 32],
        }
    );
    assert_eq!(BufferAccount::LEN, 173);
    assert_eq!(
        serialized(&buffer),
        bytes.get(..BufferAccount::LEN).unwrap()
    );
}

#[test]
fn buffer_account_rejects_malformed_headers() {
    let valid = deployed_buffer_header(0, 3);
    for bytes in [
        valid.get(..BufferAccount::LEN - 1).unwrap().to_vec(),
        [b"STORHEAD".as_slice(), valid.get(8..).unwrap()].concat(),
        deployed_buffer_header(2, 3),
    ] {
        assert!(BufferAccount::try_deserialize(&mut bytes.as_slice()).is_err());
    }
}

#[test]
fn pointer_account_round_trips_the_deployed_layout() {
    let bytes = deployed_pointer(address(7), 2);
    let pointer = PointerAccount::try_deserialize(&mut bytes.as_slice()).unwrap();
    assert_eq!(
        pointer,
        PointerAccount {
            current: address(7),
            revision: 2,
        }
    );
    assert_eq!(PointerAccount::LEN, 48);
    assert_eq!(serialized(&pointer), bytes);
}

#[test]
fn pointer_account_rejects_malformed_data() {
    let valid = deployed_pointer(Address::default(), 1);
    for bytes in [
        valid.get(..PointerAccount::LEN - 1).unwrap().to_vec(),
        [b"STORBUF1".as_slice(), valid.get(8..).unwrap()].concat(),
    ] {
        assert!(PointerAccount::try_deserialize(&mut bytes.as_slice()).is_err());
    }
}

/// Tag, owner, predecessor, total length, offset, then the length-prefixed chunk.
fn store_bytes(tag: u8, data: &StoreInstructionData) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(data.owner.as_ref());
    bytes.extend_from_slice(data.previous.as_ref());
    bytes.extend_from_slice(&data.total_length.to_le_bytes());
    bytes.extend_from_slice(&data.offset.to_le_bytes());
    bytes.extend_from_slice(&(data.chunk.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&data.chunk);
    bytes
}

#[test]
fn instruction_tags_and_data_match_the_documented_format() {
    let store = StoreInstructionData {
        owner: address(1),
        previous: address(2),
        total_length: 0x0403_0201,
        offset: 0x0807_0605,
        chunk: b"chunk".to_vec(),
    };
    assert_eq!(
        instruction::Store {
            data: store.clone()
        }
        .data(),
        store_bytes(1, &store)
    );
    assert_eq!(
        instruction::CreateBuffer {
            data: store.clone()
        }
        .data(),
        store_bytes(4, &store)
    );
    // apply's bytes are unchanged from the deployed program.
    let apply = ApplyInstructionData {
        expected_previous: address(3),
        expected_revision: 0x0807_0605_0403_0201,
        approved_hash: [4; 32],
    };
    let mut apply_bytes = vec![2];
    apply_bytes.extend_from_slice(&[3; 32]);
    apply_bytes.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    apply_bytes.extend_from_slice(&[4; 32]);
    assert_eq!(instruction::Apply { data: apply }.data(), apply_bytes);
    assert_eq!(instruction::CloseBuffer {}.data(), vec![3]);
    assert_eq!(instruction::ClosePointer {}.data(), vec![5]);
}

/// A pointer and a published record written by the deployed program stay
/// usable: a new upload is published over them, the old record closes, and
/// every account written keeps the deployed layout.
#[test]
fn records_published_by_the_deployed_program_can_be_replaced() {
    let program = storage::ID;
    let owner = Address::new_unique();
    let payer = Address::new_unique();
    let old_refund = Address::new_unique();
    let old_record = Address::new_unique();
    let replacement = Address::new_unique();
    let (pointer, _) = Address::find_program_address(&[POINTER_SEED, owner.as_ref()], &program);

    let mut old_record_data = b"STORBUF1".to_vec();
    old_record_data.push(1);
    for address in [owner, payer, old_refund, Address::default()] {
        old_record_data.extend_from_slice(address.as_ref());
    }
    old_record_data.extend_from_slice(&3u32.to_le_bytes());
    old_record_data.extend_from_slice(&hashv(&[&[0; 32], b"old"]).to_bytes());
    old_record_data.extend_from_slice(b"old");

    let svm = program_svm();
    let old_record_lamports = 10_000_000;
    let mut accounts = vec![
        (owner, system_account(1_000_000)),
        (payer, system_account(1_000_000_000)),
        (old_refund, system_account(1_000_000)),
        (
            pointer,
            funded(10_000_000, program, deployed_pointer(old_record, 5)),
        ),
        (
            old_record,
            funded(old_record_lamports, program, old_record_data),
        ),
        (replacement, system_account(0)),
        mollusk_svm::program::keyed_account_for_system_program(),
    ];

    let create_buffer = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new(replacement, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(payer, false),
        ],
        data: store_bytes(
            4,
            &StoreInstructionData {
                owner,
                previous: old_record,
                total_length: 3,
                offset: 0,
                chunk: b"new".to_vec(),
            },
        ),
    };
    let execution = svm.process_instruction(&create_buffer, &accounts);
    assert_eq!(execution.program_result, ProgramResult::Success);
    accounts = execution.resulting_accounts;

    let new_hash = hashv(&[&[0; 32], b"new"]).to_bytes();
    let mut apply_data = vec![2];
    apply_data.extend_from_slice(old_record.as_ref());
    apply_data.extend_from_slice(&5u64.to_le_bytes());
    apply_data.extend_from_slice(&new_hash);
    let apply = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new(pointer, false),
            AccountMeta::new(replacement, false),
            AccountMeta::new_readonly(owner, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new(old_record, false),
            AccountMeta::new(old_refund, false),
        ],
        data: apply_data,
    };
    let execution = svm.process_instruction(&apply, &accounts);
    assert_eq!(execution.program_result, ProgramResult::Success);
    let account = |address: Address| -> Account {
        execution
            .resulting_accounts
            .iter()
            .find(|(key, _)| *key == address)
            .map(|(_, account)| account.clone())
            .expect("fixture account")
    };

    let mut replacement_data = b"STORBUF1".to_vec();
    replacement_data.push(1);
    for address in [owner, payer, payer, old_record] {
        replacement_data.extend_from_slice(address.as_ref());
    }
    replacement_data.extend_from_slice(&3u32.to_le_bytes());
    replacement_data.extend_from_slice(&new_hash);
    replacement_data.extend_from_slice(b"new");
    assert_eq!(
        (
            account(pointer).data,
            account(replacement).data,
            account(old_record),
            account(old_refund).lamports,
        ),
        (
            deployed_pointer(replacement, 6),
            replacement_data,
            Account::default(),
            1_000_000 + old_record_lamports,
        ),
        "the pointer advances in the deployed layout and the old record refunds its destination",
    );
}
