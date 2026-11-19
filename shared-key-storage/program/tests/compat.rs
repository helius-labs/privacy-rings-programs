//! Compatibility with the deployed program: error codes, instruction bytes and
//! account layouts must match it exactly. Every expected byte string here is
//! built by hand from the documented format, independently of the types under
//! test.

mod common;

use common::{funded, program_svm, system_account, SYSTEM};
use mollusk_svm::result::ProgramResult;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_sha256_hasher::hashv;
use storage::{
    instruction::{ApplyData, InstructionTag, StoreData},
    state::{BufferHeader, Head, HEAD_PDA_SEED, MAX_RECORD_LEN, NO_RECORD},
    StorageError, APPLY, STORE,
};

fn address(byte: u8) -> Address {
    Address::new_from_array([byte; 32])
}

#[test]
fn error_codes_match_the_deployed_program() {
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
    let codes: Vec<u32> = errors.iter().map(|error| *error as u32).collect();
    assert_eq!(codes, (7000..=7007).collect::<Vec<u32>>());
}

#[test]
fn only_the_three_tags_decode() {
    let decoded: Vec<_> = (0..=u8::MAX)
        .filter_map(|tag| InstructionTag::try_from(tag).ok())
        .collect();
    assert_eq!(
        decoded,
        [
            InstructionTag::Store,
            InstructionTag::Apply,
            InstructionTag::Close
        ]
    );
}

#[test]
fn store_data_matches_the_deployed_wire_format() {
    let data = StoreData {
        owner: address(1),
        previous: address(2),
        total_length: 0x0403_0201,
        offset: 0x0807_0605,
    };
    let mut expected = vec![1; 32];
    expected.extend_from_slice(&[2; 32]);
    expected.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(wincode::serialize(&data).unwrap(), expected);
    assert_eq!(expected.len(), StoreData::LEN);

    expected.extend_from_slice(b"chunk");
    assert_eq!(StoreData::parse(&expected), Ok((data, &b"chunk"[..])));
    assert_eq!(
        StoreData::parse(expected.get(..StoreData::LEN - 1).unwrap()),
        Err(ProgramError::InvalidInstructionData)
    );
}

#[test]
fn apply_data_matches_the_deployed_wire_format() {
    let data = ApplyData {
        expected_previous: address(3),
        expected_revision: 0x0807_0605_0403_0201,
        approved_hash: [4; 32],
    };
    let mut expected = vec![3; 32];
    expected.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    expected.extend_from_slice(&[4; 32]);
    assert_eq!(wincode::serialize(&data).unwrap(), expected);
    assert_eq!(expected.len(), ApplyData::LEN);
    assert_eq!(ApplyData::from_bytes(&expected), Ok(data));

    let short = expected.get(..ApplyData::LEN - 1).unwrap().to_vec();
    expected.push(0);
    for bytes in [short, expected] {
        assert_eq!(
            ApplyData::from_bytes(&bytes),
            Err(ProgramError::InvalidInstructionData)
        );
    }
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

/// The head exactly as the deployed program writes it.
fn deployed_head(current: Address, revision: u64) -> Vec<u8> {
    let mut bytes = b"STORHEAD".to_vec();
    bytes.extend_from_slice(current.as_ref());
    bytes.extend_from_slice(&revision.to_le_bytes());
    bytes
}

#[test]
fn buffer_header_round_trips_the_deployed_layout() {
    let mut bytes = deployed_buffer_header(1, 3);
    bytes.extend_from_slice(b"abc");
    let header = BufferHeader::read_from(&bytes).unwrap();
    assert_eq!(
        header,
        BufferHeader {
            sealed: 1,
            data_hash: [5; 32],
            ..BufferHeader::new(address(1), address(2), address(3), address(4), 3)
        }
    );
    assert!(header.is_sealed());
    assert_eq!(header.total_length(), 3);

    let mut rewritten = vec![0; bytes.len()];
    header.write_to(&mut rewritten).unwrap();
    rewritten
        .get_mut(BufferHeader::LEN..)
        .unwrap()
        .copy_from_slice(b"abc");
    assert_eq!(rewritten, bytes);
}

#[test]
fn buffer_header_rejects_what_the_deployed_program_rejects() {
    let valid = deployed_buffer_header(0, 3);
    for bytes in [
        valid.get(..BufferHeader::LEN - 1).unwrap().to_vec(),
        [b"STORHEAD".as_slice(), valid.get(8..).unwrap()].concat(),
        deployed_buffer_header(2, 3),
    ] {
        assert_eq!(
            BufferHeader::read_from(&bytes),
            Err(ProgramError::InvalidAccountData)
        );
    }
    let mut overfull = valid;
    overfull.extend_from_slice(b"abcd");
    for bytes in [
        deployed_buffer_header(0, 0),
        deployed_buffer_header(0, MAX_RECORD_LEN as u32 + 1),
        overfull,
    ] {
        assert_eq!(
            BufferHeader::read_from(&bytes),
            Err(ProgramError::Custom(StorageError::InvalidLength as u32))
        );
    }
}

#[test]
fn head_round_trips_the_deployed_layout() {
    let bytes = deployed_head(address(7), 2);
    let head = Head::read_from(&bytes).unwrap();
    assert_eq!(head, Head::new(address(7), 2));
    assert_eq!(head.revision(), 2);

    let mut rewritten = vec![0; Head::LEN];
    head.write_to(&mut rewritten).unwrap();
    assert_eq!(rewritten, bytes);
}

#[test]
fn head_rejects_what_the_deployed_program_rejects() {
    let valid = deployed_head(address(7), 1);
    let mut too_long = valid.clone();
    too_long.push(0);
    for bytes in [
        valid.get(..Head::LEN - 1).unwrap().to_vec(),
        too_long,
        [b"STORBUF1".as_slice(), valid.get(8..).unwrap()].concat(),
        deployed_head(NO_RECORD, 1),
        deployed_head(address(7), 0),
    ] {
        assert_eq!(
            Head::read_from(&bytes),
            Err(ProgramError::InvalidAccountData)
        );
    }
}

/// A head and a published record written by the deployed program stay usable:
/// the rebuilt program appends a replacement, publishes it over them and
/// closes the old record, and every account it writes keeps the old layout.
#[test]
fn records_published_by_the_deployed_program_can_be_replaced() {
    let program = storage::ID;
    let owner = Address::new_unique();
    let payer = Address::new_unique();
    let old_refund = Address::new_unique();
    let old_record = Address::new_unique();
    let replacement = Address::new_unique();
    let (head, _) = Address::find_program_address(&[HEAD_PDA_SEED, owner.as_ref()], &program);

    let mut old_record_data = b"STORBUF1".to_vec();
    old_record_data.push(1);
    for address in [owner, payer, old_refund, NO_RECORD] {
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
            head,
            funded(10_000_000, program, deployed_head(old_record, 5)),
        ),
        (
            old_record,
            funded(old_record_lamports, program, old_record_data),
        ),
        (replacement, system_account(0)),
        mollusk_svm::program::keyed_account_for_system_program(),
    ];

    let mut store_data = vec![STORE];
    store_data.extend_from_slice(owner.as_ref());
    store_data.extend_from_slice(old_record.as_ref());
    store_data.extend_from_slice(&3u32.to_le_bytes());
    store_data.extend_from_slice(&0u32.to_le_bytes());
    store_data.extend_from_slice(b"new");
    let store = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new(replacement, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(payer, false),
        ],
        data: store_data,
    };
    let execution = svm.process_instruction(&store, &accounts);
    assert_eq!(execution.program_result, ProgramResult::Success);
    accounts = execution.resulting_accounts;

    let new_hash = hashv(&[&[0; 32], b"new"]).to_bytes();
    let mut apply_data = vec![APPLY];
    apply_data.extend_from_slice(old_record.as_ref());
    apply_data.extend_from_slice(&5u64.to_le_bytes());
    apply_data.extend_from_slice(&new_hash);
    let apply = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new(head, false),
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
    let account = |address: Address| {
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
            account(head).data,
            account(replacement).data,
            account(old_record),
            account(old_refund).lamports,
        ),
        (
            deployed_head(replacement, 6),
            replacement_data,
            Account::default(),
            1_000_000 + old_record_lamports,
        ),
        "the head advances in the old layout and the old record refunds its destination",
    );
}
