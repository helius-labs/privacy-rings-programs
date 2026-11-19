//! Setup shared by the integration tests. Each test crate uses a subset.
#![allow(dead_code)]

use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_address::Address;

pub const SYSTEM: Address = Address::new_from_array([0; 32]);

/// Registers the built SBF program at `address`.
pub fn add_program(svm: &mut Mollusk, address: &Address) {
    let executable = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/target/deploy/storage.so"
    ))
    .expect("build the SBF program before running integration tests");
    svm.add_program_with_loader_and_elf(
        address,
        &mollusk_svm::program::loader_keys::LOADER_V3,
        &executable,
    );
}

/// A Mollusk instance with the program at its declared address.
pub fn program_svm() -> Mollusk {
    let mut svm = Mollusk::default();
    add_program(&mut svm, &storage::ID);
    svm
}

pub fn funded(lamports: u64, owner: Address, data: Vec<u8>) -> Account {
    Account {
        lamports,
        owner,
        data,
        ..Account::default()
    }
}

pub fn system_account(lamports: u64) -> Account {
    funded(lamports, SYSTEM, vec![])
}
