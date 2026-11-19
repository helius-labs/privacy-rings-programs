use core::mem::{align_of, size_of};

use pinocchio::{error::ProgramError, Address, ProgramResult};
use wincode::{SchemaRead, SchemaWrite, ZeroCopy};

use super::MAX_RECORD_LEN;
use crate::error::StorageError;

const BUFFER_DISCRIMINATOR: [u8; 8] = *b"STORBUF1";

/// Start of every buffer account, followed by the uploaded bytes.
///
/// Every field is a byte array so the layout has alignment 1 and no padding:
/// wincode casts it in place, and `total_length` keeps its deployed offset
/// (137), which a `u32` field could not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
#[wincode(assert_zero_copy)]
#[repr(C)]
pub struct BufferHeader {
    pub discriminator: [u8; 8],
    /// 0 while uploading, 1 once published. Any other value is invalid.
    pub sealed: u8,
    pub owner: Address,
    /// Paid the buffer's rent and signs `close`.
    pub payer: Address,
    /// Receives the rent when the buffer is cancelled or superseded.
    pub refund: Address,
    /// The record this upload replaces; an update precondition, not history.
    pub previous: Address,
    pub total_length: [u8; 4],
    /// `SHA256(data_hash || chunk)` over the chunks written so far, from zero.
    pub data_hash: [u8; 32],
}

// Deployed buffers have a 173-byte header; the layout must never change it.
const _: () = assert!(BufferHeader::LEN == 173);
const _: () = assert!(align_of::<BufferHeader>() == 1);

impl BufferHeader {
    pub const LEN: usize = size_of::<Self>();

    /// The header the first `store` writes: unsealed, nothing hashed yet.
    pub fn new(
        owner: Address,
        payer: Address,
        refund: Address,
        previous: Address,
        total_length: u32,
    ) -> Self {
        Self {
            discriminator: BUFFER_DISCRIMINATOR,
            sealed: 0,
            owner,
            payer,
            refund,
            previous,
            total_length: total_length.to_le_bytes(),
            data_hash: [0; 32],
        }
    }

    pub fn total_length(&self) -> u32 {
        u32::from_le_bytes(self.total_length)
    }

    pub fn is_sealed(&self) -> bool {
        self.sealed == 1
    }

    pub fn seal(&mut self) {
        self.sealed = 1;
    }

    /// Reads and validates the header of a buffer account's data. The
    /// uploaded bytes after it may not exceed the recorded total length.
    pub fn read_from(account_data: &[u8]) -> Result<Self, ProgramError> {
        let (header_bytes, uploaded) = account_data
            .split_at_checked(Self::LEN)
            .ok_or(ProgramError::InvalidAccountData)?;
        let header =
            *Self::from_bytes(header_bytes).map_err(|_| ProgramError::InvalidAccountData)?;
        if header.discriminator != BUFFER_DISCRIMINATOR || header.sealed > 1 {
            return Err(ProgramError::InvalidAccountData);
        }
        let total_length = header.total_length() as usize;
        if total_length == 0 || total_length > MAX_RECORD_LEN || uploaded.len() > total_length {
            return Err(StorageError::InvalidLength.into());
        }
        Ok(header)
    }

    /// Overwrites the header at the start of a buffer account's data.
    pub fn write_to(&self, account_data: &mut [u8]) -> ProgramResult {
        let header_bytes = account_data
            .get_mut(..Self::LEN)
            .ok_or(ProgramError::InvalidAccountData)?;
        *Self::from_bytes_mut(header_bytes).map_err(|_| ProgramError::InvalidAccountData)? = *self;
        Ok(())
    }
}
