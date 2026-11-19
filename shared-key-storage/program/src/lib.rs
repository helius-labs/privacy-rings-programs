//! Append-only uploads, published atomically through an owner-authorized head.
//! Publishing a replacement atomically closes its predecessor and refunds its
//! rent to whoever paid for that upload.

pub mod error;
pub mod instruction;
mod instructions;
mod processor;
pub mod state;

pub use error::StorageError;
pub use instruction::{APPLY, CLOSE, STORE};
pub use processor::process_instruction;

pinocchio::address::declare_id!("Stor9L8wQBAGcAcoUcADt5sWYYaEA65Ws2Cgt5UUqXj");

#[cfg(feature = "bpf-entrypoint")]
mod entrypoint {
    pinocchio::entrypoint!(crate::process_instruction);
}
