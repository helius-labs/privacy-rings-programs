//! Instruction tags and data. Every instruction is a one-byte tag followed by
//! its data; integers are fixed-width little endian (wincode's default), so
//! these structs encode exactly the bytes the deployed program accepts.

use pinocchio::{error::ProgramError, Address};
use wincode::{SchemaRead, SchemaWrite};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum InstructionTag {
    /// Appends a chunk to an unpublished buffer, creating it on the first chunk.
    Store = 1,
    /// Publishes a complete buffer through the owner's head and closes its predecessor.
    Apply = 2,
    /// Cancels an unpublished buffer.
    Close = 3,
}

impl TryFrom<u8> for InstructionTag {
    type Error = ProgramError;

    fn try_from(tag: u8) -> Result<Self, Self::Error> {
        match tag {
            1 => Ok(Self::Store),
            2 => Ok(Self::Apply),
            3 => Ok(Self::Close),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

pub const STORE: u8 = InstructionTag::Store as u8;
pub const APPLY: u8 = InstructionTag::Apply as u8;
pub const CLOSE: u8 = InstructionTag::Close as u8;

/// `store` data before the chunk.
///
/// Accounts: buffer (writable, signer), rent payer (writable, signer), System
/// Program, refund destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
#[repr(C)]
pub struct StoreData {
    pub owner: Address,
    pub previous: Address,
    pub total_length: u32,
    pub offset: u32,
}

// No padding, so the in-memory size is the encoded size: 72 deployed bytes.
const _: () = assert!(StoreData::LEN == 72);

impl StoreData {
    pub const LEN: usize = size_of::<Self>();

    /// Splits `store` data into its fixed fields and the chunk that follows them.
    pub fn parse(data: &[u8]) -> Result<(Self, &[u8]), ProgramError> {
        let (fields, chunk) = data
            .split_at_checked(Self::LEN)
            .ok_or(ProgramError::InvalidInstructionData)?;
        let fields =
            wincode::deserialize_exact(fields).map_err(|_| ProgramError::InvalidInstructionData)?;
        Ok((fields, chunk))
    }
}

/// `apply` data.
///
/// Accounts: head (writable), buffer (writable), owner (signer), rent payer
/// (writable, signer), System Program, predecessor (writable), predecessor's
/// refund destination (writable). The first publication passes the System
/// Program in both predecessor slots.
#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
#[repr(C)]
pub struct ApplyData {
    pub expected_previous: Address,
    pub expected_revision: u64,
    pub approved_hash: [u8; 32],
}

// No padding, so the in-memory size is the encoded size: 72 deployed bytes.
const _: () = assert!(ApplyData::LEN == 72);

impl ApplyData {
    pub const LEN: usize = size_of::<Self>();

    /// Rejects missing and trailing bytes.
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        wincode::deserialize_exact(data).map_err(|_| ProgramError::InvalidInstructionData)
    }
}
